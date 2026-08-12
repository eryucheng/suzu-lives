#!/usr/bin/env node

import {
  resolveAgentConversationDataRoot,
  resolveAgentDataRoot,
  resolveSuzuLivesDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import {
  executeInternalCapability,
  InternalCapabilityCliError,
  internalCapabilityErrorDetails,
  internalCapabilityFailure,
  internalCapabilitySuccess,
  parseInternalCapabilityRequest,
} from "@suzu-lives/capability-registry/internal-cli";
import { resolveBrowserStarterPath } from "../../browser-automation/src/site-automation/common/config.mjs";
import { runScheduleCli } from "@suzu-lives/task-scheduler";
import { runTravelingMerchantCli, TravelingMerchantError } from "@suzu-lives/traveling-merchant";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseOptions(values, { booleanOptions = [] } = {}) {
  const options = {};
  const positional = [];
  const booleans = new Set(booleanOptions);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (booleans.has(key)) {
      options[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (!key || !next || next.startsWith("--")) throw new Error(`选项 ${value} 缺少值。`);
    options[key] = next;
    index += 1;
  }
  return { options, positional };
}

function help() {
  return {
    status: "help",
    commands: [
      "suzu-lives visual-reference-manager init|list|show|validate|apply --scope shared|contact [--data-root <software-data-root>]",
      "suzu-lives capability image-vision analyze --input-json '<JSON>' [--data-root <software-data-root>] [--workspace-root <workspace>]",
      "suzu-lives capability video-understanding analyze --input-json '<JSON>' [--data-root <software-data-root>] [--workspace-root <workspace>]",
      "suzu-lives capability image-generation generate --input-json '<JSON>' [--data-root <software-data-root>] [--workspace-root <workspace>]",
      "suzu-lives capability phone-camera generate --input-json '<JSON>' [--data-root <software-data-root>] [--workspace-root <workspace>]",
      "suzu-lives capability voice-message generate --input-json '<JSON>' [--data-root <software-data-root>] [--workspace-root <workspace>]",
      "suzu-lives traveling-merchant [--dry-run] [--force] [--fixture <local-html>] [--test-notification] [--config <software-data-config>] [--data-root <software-data-root>]",
      "suzu-lives site browser start|check [--data-root <software-data-root>] [--project-root <agent-project>]",
      "suzu-lives site list|describe <site>|<site> <action> [--data-root <software-data-root>] [--project-root <agent-project>]",
      "suzu-lives iphone-bridge send <主题> <内容> | receive [--init|--once|--watch|--preview <主题> <内容>]",
      "suzu-lives conversation-attachment --data-root <software-data-root> --project-root <agent-project> --session-id <Claude-session-id> --image <absolute-local-image> | --audio <absolute-local-mp3> | --file <absolute-local-file>",
      "suzu-lives schedule add --delay <Ns|Nm|Nh|Nd> --prompt <task> --session-id <Claude-session-id> --project-root <agent-project> [--desc <text>] [--data-root <software-data-root>]",
      "suzu-lives schedule add --cron '<5-field Cron>' --exec traveling-merchant [--desc <text>] [--data-root <software-data-root>]",
      "suzu-lives schedule list [--data-root <software-data-root>] | remove <task-id> [--data-root <software-data-root>]",
    ],
  };
}

const MAX_CONVERSATION_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const CONVERSATION_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isImageAttachmentPath(value) {
  return new Set([".avif", ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]).has(path.extname(value).toLowerCase());
}

function isAudioAttachmentPath(value) {
  return path.extname(value).toLowerCase() === ".mp3";
}

function conversationMediaDirectory({ dataRoot, projectRoot, sessionId }) {
  const configuredRoot = String(dataRoot || "").trim();
  const project = String(projectRoot || "").trim();
  const id = String(sessionId || "").trim();
  if (!path.isAbsolute(configuredRoot)) throw new Error("conversation-attachment 的 data-root 必须是绝对路径。 ");
  if (!path.isAbsolute(project)) throw new Error("conversation-attachment 的 project-root 必须是绝对路径。 ");
  if (!CONVERSATION_SESSION_ID.test(id)) throw new Error("conversation-attachment 的 session-id 无效。 ");
  const root = softwareDataRoot(configuredRoot);
  if (!root) throw new Error("conversation-attachment 无法定位 Suzu Lives 软件数据目录。 ");
  return path.join(resolveAgentConversationDataRoot({
    dataRoot: root,
    projectRoot: project,
    sessionId: id,
  }), "attachments");
}

function cachedAttachmentFileName(value) {
  const original = path.basename(String(value || "")).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "").slice(0, 180);
  return `${Date.now()}-${randomUUID()}-${original || "attachment.bin"}`;
}

function cacheConversationAttachment({ dataRoot, projectRoot, sessionId, sourcePath, fileName }) {
  const directory = conversationMediaDirectory({ dataRoot, projectRoot, sessionId });
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, cachedAttachmentFileName(fileName));
  const temporary = `${target}.tmp`;
  try {
    copyFileSync(sourcePath, temporary);
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Keep the original copy error. */ }
    throw new Error(`无法保存会话附件副本：${error?.message || error}`);
  }
  return target;
}

function runConversationAttachmentCommand(values) {
  const entries = [];
  let dataRoot = "";
  let projectRoot = "";
  let sessionId = "";
  for (let index = 0; index < values.length; index += 1) {
    const option = String(values[index] || "").trim();
    const source = String(values[index + 1] || "").trim();
    if (option === "--data-root" || option === "--project-root" || option === "--session-id") {
      if (!source || source.startsWith("--")) throw new Error(`${option} 需要一个值。`);
      if (option === "--data-root") dataRoot = source;
      else if (option === "--project-root") projectRoot = source;
      else sessionId = source;
      index += 1;
      continue;
    }
    if (!new Set(["--image", "--audio", "--file"]).has(option)) throw new Error(`conversation-attachment 不支持参数 ${option || "（空）"}。`);
    if (!source || source.startsWith("--")) throw new Error(`${option} 需要一个绝对路径。`);
    index += 1;
    if (!path.isAbsolute(source)) throw new Error("发送图片、音频或文件时必须使用绝对路径。 ");
    const resolved = path.resolve(source);
    let info;
    try { info = statSync(resolved); }
    catch { throw new Error(`找不到要交付的文件：${resolved}`); }
    if (!info.isFile()) throw new Error(`要交付的路径不是普通文件：${resolved}`);
    if (info.size <= 0) throw new Error(`要交付的文件为空：${resolved}`);
    if (info.size > MAX_CONVERSATION_ATTACHMENT_BYTES) {
      throw new Error(`要交付的文件超过 ${MAX_CONVERSATION_ATTACHMENT_BYTES >> 20} MiB 上限：${resolved}`);
    }
    const kind = option === "--image" ? "image" : option === "--audio" ? "audio" : "file";
    if (kind === "image" && !isImageAttachmentPath(resolved)) throw new Error(`--image 只接受图片文件：${resolved}`);
    if (kind === "audio" && !isAudioAttachmentPath(resolved)) throw new Error(`--audio 只接受 MP3 文件：${resolved}`);
    entries.push({ kind, sourcePath: resolved, fileName: path.basename(resolved), size: info.size });
  }
  if (!entries.length) throw new Error("conversation-attachment 需要 --image、--audio 或 --file。 ");
  if (new Set([Boolean(dataRoot), Boolean(projectRoot), Boolean(sessionId)]).size !== 1) {
    throw new Error("conversation-attachment 的 data-root、project-root 与 session-id 必须同时提供。 ");
  }
  const items = entries.map((entry) => ({
    kind: entry.kind,
    path: dataRoot ? cacheConversationAttachment({
      dataRoot,
      projectRoot,
      sessionId,
      sourcePath: entry.sourcePath,
      fileName: entry.fileName,
    }) : entry.sourcePath,
    fileName: entry.fileName,
    size: entry.size,
  }));
  return {
    status: "ok",
    type: "suzu-conversation-attachment",
    receiptId: `attachment-${randomUUID()}`,
    items,
  };
}

async function runInternalCapabilityCommand(values, { connectionResolver = null } = {}) {
  let capabilityId = "";
  let action = "";
  try {
    const { options, positional } = parseOptions(values);
    capabilityId = String(positional[0] || "").trim().toLowerCase();
    action = String(positional[1] || "").trim().toLowerCase();
    const request = parseInternalCapabilityRequest({ positional, options });
    capabilityId = request.capabilityId;
    action = request.action;
    const dataRoot = softwareDataRoot(request.dataRoot || process.env.SUZU_LIVES_DATA_ROOT || "");
    const workspaceRoot = request.workspaceRoot || process.cwd();
    const agentId = stableAgentId(workspaceRoot);
    if (!agentId) {
      throw new InternalCapabilityCliError("无法定位当前 Agent 工作区的软件身份。", { code: "runtime_identity_missing", exitCode: 10 });
    }
    const connection = typeof connectionResolver === "function"
      ? await connectionResolver({ kind: capabilityId, dataRoot, agentId })
      : null;
    const result = await executeInternalCapability({
      request,
      runtime: {
        dataRoot,
        agentId,
        ledgerPath: path.join(resolveAgentDataRoot({ dataRoot, agentId }), "cost-ledger", "events.jsonl"),
        connection,
        environment: process.env,
      },
    });
    return {
      format: "internal-capability",
      result: internalCapabilitySuccess({ capabilityId, action, result }),
      exitCode: 0,
    };
  } catch (error) {
    const details = internalCapabilityErrorDetails(error);
    return {
      format: "internal-capability",
      result: internalCapabilityFailure({ capabilityId, action, code: details.code, message: details.message }),
      exitCode: details.exitCode,
    };
  }
}

function softwareDataRoot(value) {
  try {
    return resolveSuzuLivesDataRoot({
      configuredRoot: value || process.env.SUZU_LIVES_DATA_ROOT || "",
      localAppData: process.env.LOCALAPPDATA || "",
      appData: process.env.APPDATA || "",
      fallbackBase: "",
      fallbackToLocatorWhenMissing: true,
    });
  } catch {
    return "";
  }
}

function resolvedScheduleArguments(values) {
  const resolved = [...values];
  for (let index = 0; index < resolved.length; index += 1) {
    if (resolved[index] !== "--data-root") continue;
    const configuredRoot = String(resolved[index + 1] || "").trim();
    if (!configuredRoot || configuredRoot.startsWith("--")) continue;
    const dataRoot = softwareDataRoot(configuredRoot);
    if (!dataRoot) throw new Error("schedule 无法定位 Suzu Lives 软件数据目录。 ");
    resolved[index + 1] = dataRoot;
    index += 1;
  }
  return resolved;
}

function runDedicatedBrowserCommand(values) {
  const { options, positional } = parseOptions(values, { booleanOptions: ["check"] });
  const unknown = Object.keys(options).filter((key) => !new Set(["check", "data-root", "project-root", "agent-id"]).has(key));
  if (unknown.length || positional.length) throw new Error(`site browser 不支持选项或参数 ${unknown[0] ? `--${unknown[0]}` : positional[0]}。`);
  const dataRoot = softwareDataRoot(options["data-root"] || process.env.SUZU_LIVES_DATA_ROOT || "");
  if (!dataRoot) throw new Error("site browser 需要 Suzu Lives 软件数据目录。 ");
  const browserRuntimeRoot = path.join(dataRoot, "capabilities", "web-browser");
  const scriptPath = resolveBrowserStarterPath();
  const result = spawnSync(process.env.SUZU_LIVES_PYTHON || "python", [scriptPath, ...(options.check ? ["--check"] : [])], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SUZU_LIVES_BROWSER_RUNTIME_DIR: browserRuntimeRoot },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return { format: "passthrough" };
}

function runSiteBrowserCommand(values) {
  const action = String(values[0] || "").trim().toLowerCase();
  if (!action || !["start", "check"].includes(action)) throw new Error("site browser 需要 start 或 check。 ");
  const forwarded = values.slice(1);
  return runDedicatedBrowserCommand(action === "check" ? ["--check", ...forwarded] : forwarded);
}

function runTravelingMerchantCommand(values) {
  const result = runTravelingMerchantCli(values);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
  return { format: "passthrough" };
}

async function main({ connectionResolver = null } = {}) {
  if (process.argv[2] === "visual-reference-manager") {
    const { runVisualReferenceManagerCli } = await import("@suzu-lives/visual-reference-manager");
    return { format: "visual-reference-manager", result: await runVisualReferenceManagerCli(process.argv.slice(3)) };
  }
  if (process.argv[2] === "traveling-merchant") return runTravelingMerchantCommand(process.argv.slice(3));
  if (process.argv[2] === "site") {
    if (process.argv[3] === "browser") return runSiteBrowserCommand(process.argv.slice(4));
    const { runSiteAutomationCli } = await import("../../browser-automation/src/site-automation/site.mjs");
    const code = await runSiteAutomationCli(process.argv.slice(3));
    process.exitCode = code;
    return { format: "passthrough" };
  }
  if (process.argv[2] === "iphone-bridge") {
    const { runIphoneBridgeCli } = await import("@suzu-lives/iphone-bridge");
    const result = runIphoneBridgeCli({ args: process.argv.slice(3) });
    process.exitCode = result.status;
    return { format: "passthrough" };
  }
  if (process.argv[2] === "conversation-attachment") return runConversationAttachmentCommand(process.argv.slice(3));
  if (process.argv[2] === "schedule") {
    return runScheduleCli(resolvedScheduleArguments(process.argv.slice(3)), {
      defaultDataRoot: softwareDataRoot(process.env.SUZU_LIVES_DATA_ROOT || ""),
    });
  }
  if (process.argv[2] === "capability") {
    return runInternalCapabilityCommand(process.argv.slice(3), { connectionResolver });
  }
  return help();
}

export async function runSuzuLivesCli({ args = process.argv.slice(2), connectionResolver = null } = {}) {
  const originalArgv = process.argv;
  process.argv = [...originalArgv.slice(0, 2), ...args];
  try {
    const result = await main({ connectionResolver });
    if (result?.format === "internal-capability") {
      emit(result.result);
      process.exitCode = result.exitCode;
      if (result.exitCode) {
        const error = result.result.error || {};
        process.stderr.write(`CAPABILITY_ERROR ${error.code || "internal_error"}: ${error.message || "内部能力执行失败。"}\n`);
      }
      return result.result;
    }
    if (result?.format === "visual-reference-manager") {
      emit(result.result);
      return result;
    }
    if (result?.format === "passthrough") return;
    emit(result);
    return result;
  } catch (error) {
    if (process.argv[2] === "visual-reference-manager") {
      process.stderr.write(`REFERENCE_ERROR: ${error?.message || "视觉参考资料库操作失败。"}\n`);
      process.exitCode = 1;
      return null;
    }
    if (error instanceof TravelingMerchantError) {
      process.stderr.write(`MERCHANT_ERROR: ${error.message}\n`);
      process.exitCode = error.exitCode || 4;
      return null;
    }
    emit({ status: "error", message: error?.message || String(error) });
    process.exitCode = 1;
    return null;
  } finally {
    process.argv = originalArgv;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSuzuLivesCli();
}
