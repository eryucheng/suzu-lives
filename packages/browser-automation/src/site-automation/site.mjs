#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  closeExistingSitePages,
  connectBrowser,
  findOrOpenSitePage,
  stopDedicatedBrowser,
} from "./common/browser.mjs";
import {
  MODULE_ROOT,
  isSiteActionEnabled,
  isSiteEnabled,
  loadConfig,
  loadRegistry,
  loadSiteManifest,
  resolveSite,
} from "./common/config.mjs";
import {
  emit,
  parseCliOptions,
  saveDiagnostics,
  SiteAutomationError,
} from "./common/runtime.mjs";

function usage() {
  return {
    status: "help",
    commands: [
      "node site.mjs list",
      "node site.mjs describe <site>",
      "node site.mjs <site> <action> [--text <value>] [--state on|off]",
    ],
  };
}

function restoreShellSplitTextOption(options, positional) {
  if (positional.length <= 2) return;
  const key = ["text", "keyword"].find(
    (candidate) => typeof options[candidate] === "string",
  );
  if (!key) return;
  const fragments = positional.splice(2);
  options[key] = [options[key], ...fragments]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function publicSiteDescription(siteId, entry, manifest) {
  return {
    id: siteId,
    name: entry.name || manifest.name,
    aliases: entry.aliases || [],
    homeUrl: manifest.homeUrl,
    actions: manifest.actions,
  };
}

export async function runSiteAutomationCli(rawArgs = process.argv.slice(2), context = {}) {
  const { options, positional } = parseCliOptions(rawArgs);
  const runtimeContext = {
    dataRoot: options["data-root"] || context.dataRoot || "",
    projectRoot: options["project-root"] || context.projectRoot || "",
    agentId: options["agent-id"] || context.agentId || "",
    configPath: options.config || context.configPath || "",
  };
  for (const key of ["data-root", "project-root", "agent-id", "config"]) delete options[key];
  restoreShellSplitTextOption(options, positional);
  const command = positional[0] || "help";
  const registry = loadRegistry();

  if (command === "help" || options.help) {
    emit(usage());
    return 0;
  }

  if (command === "list") {
    const sites = Object.entries(registry.sites).map(([siteId, entry]) => {
      const { manifest } = loadSiteManifest(entry);
      return publicSiteDescription(siteId, entry, manifest);
    });
    emit({ status: "ok", sites });
    return 0;
  }

  if (command === "describe") {
    const resolved = resolveSite(registry, positional[1]);
    if (!resolved) {
      throw new SiteAutomationError(
        "SITE_NOT_REGISTERED",
        `Website is not registered: ${positional[1] || "<empty>"}`,
      );
    }
    const { manifest } = loadSiteManifest(resolved.entry);
    emit({
      status: "ok",
      site: publicSiteDescription(resolved.siteId, resolved.entry, manifest),
    });
    return 0;
  }

  const resolved = resolveSite(registry, command);
  if (!resolved) {
    throw new SiteAutomationError(
      "SITE_NOT_REGISTERED",
      `Website is not registered: ${command}`,
    );
  }
  const action = positional[1];
  if (!action) {
    throw new SiteAutomationError(
      "ACTION_REQUIRED",
      `Action is required. Run describe ${resolved.siteId} first.`,
    );
  }

  const { manifest } = loadSiteManifest(resolved.entry);
  if (!manifest.actions?.[action]) {
    throw new SiteAutomationError(
      "ACTION_NOT_SUPPORTED",
      `${manifest.name} does not support action: ${action}`,
    );
  }

  const config = loadConfig(runtimeContext);
  if (!isSiteEnabled(config, resolved.siteId)) {
    throw new SiteAutomationError(
      "SITE_DISABLED",
      `${manifest.name} 已在网页自动化中关闭。`,
    );
  }
  if (!isSiteActionEnabled(config, resolved.siteId, action)) {
    throw new SiteAutomationError(
      "SITE_ACTION_DISABLED",
      `${manifest.name} 的“${manifest.actions[action].label || action}”已关闭。`,
    );
  }
  let page = null;
  try {
    const connection = await connectBrowser(
      config,
      action === "close"
        ? { autoStart: false, optional: true }
        : undefined,
    );
    if (action === "close") {
      const result = connection
        ? await closeExistingSitePages(connection.context, manifest)
        : { status: "ok", changed: false, closedPages: 0 };
      const browser = resolved.siteId === "douyin"
        ? stopDedicatedBrowser(config)
        : null;
      emit({
        site: resolved.siteId,
        action,
        ...result,
        ...(browser ? { browser } : {}),
      });
      return 0;
    }
    const { context } = connection;
    page = await findOrOpenSitePage(context, manifest);
    const adapterUrl = pathToFileURL(
      path.resolve(MODULE_ROOT, resolved.entry.entry),
    ).href;
    const adapter = await import(adapterUrl);
    const result = await adapter.run({
      action,
      options,
      page,
      config,
      manifest,
      siteId: resolved.siteId,
    });
    emit({
      site: resolved.siteId,
      action,
      ...result,
    });
    return result.status === "error" ? 1 : 0;
  } catch (error) {
    const diagnosticPath = await saveDiagnostics(
      page,
      config,
      resolved.siteId,
      action,
      error,
    );
    emit({
      status: "error",
      site: resolved.siteId,
      action,
      code: error.code || "AUTOMATION_FAILED",
      error: error.message || String(error),
      diagnosticPath,
      ...(error.details ? { details: error.details } : {}),
    });
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runSiteAutomationCli()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      emit({
        status: "error",
        code: error.code || "SITE_AUTOMATION_FAILED",
        error: error.message || String(error),
        ...(error.details ? { details: error.details } : {}),
      });
      process.exit(1);
    });
}
