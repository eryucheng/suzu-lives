import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MANAGED_CLAUDE_API_ENV_KEYS } from "./agent-runtime-config.mjs";

const MAX_DIRECTORY_ITEMS = 180;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const CONTACT_ID_PATTERN = /^contact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/iu;

const SUZU_DATA_ENTRIES = new Set([
  "agents", "automation", "blob_storage", "capabilities", "connections", "diagnostics", "external-capabilities", "settings.json", "voice-message", "wechat-link",
]);
const ELECTRON_PROFILE_ENTRIES = new Set([
  "Cache", "Code Cache", "DawnGraphiteCache", "DawnWebGPUCache", "Dictionaries", "GPUCache", "Local Storage", "Network", "Session Storage", "Shared Dictionary", "SharedStorage", "DevToolsActivePort", "DIPS", "Local State", "Preferences",
]);
const SUZU_CAPABILITY_ENTRIES = new Set([
  "computer-camera", "image-generation", "image-vision", "iphone-bridge", "managed-registrations-v1.json", "phone-camera", "time-awareness", "video-understanding", "voice-message",
]);
const CLAUDE_RUNTIME_ENTRIES = new Set([
  ".last-cleanup", "backups", "debug", "history.jsonl", "plans", "projects", "session-env", "sessions", "shell-snapshots", "statsig", "tasks", "telemetry", "todos",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function absolutePath(value) {
  const source = clean(value);
  return source && path.isAbsolute(source) ? path.resolve(source) : "";
}

function directChild(root, name) {
  const target = path.resolve(root, name);
  return path.dirname(target) === root ? target : "";
}

function itemType(stat) {
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symbolic-link";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function modifiedAt(stat) {
  return stat?.mtime instanceof Date && Number.isFinite(stat.mtime.getTime()) ? stat.mtime.toISOString() : "";
}

function item({ detail, id, metadata = null, ownership = "managed", path: targetPath, state = "ok", stat = null, title, type = "" } = {}) {
  return {
    id: clean(id),
    title: clean(title) || "未命名项目",
    path: absolutePath(targetPath),
    ownership,
    state,
    type: type || itemType(stat),
    detail: clean(detail),
    modifiedAt: modifiedAt(stat),
    size: Number.isFinite(stat?.size) ? stat.size : 0,
    ...(metadata ? { metadata } : {}),
  };
}

function errorText(error, fallback) {
  if (error?.code === "EACCES" || error?.code === "EPERM") return `${fallback}：没有读取权限。`;
  return fallback;
}

async function lstat(fsOps, targetPath) {
  try {
    return { stat: await fsOps.lstat(targetPath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { error };
  }
}

async function inspectDirectory(fsOps, targetPath, { id, ownership = "managed", required = false, title } = {}) {
  const found = await lstat(fsOps, targetPath);
  if (found.missing) {
    return {
      item: item({ id, ownership, path: targetPath, state: required ? "warning" : "missing", title, type: "missing", detail: required ? "未找到，可能被移动或删除。" : "未创建。" }),
      entries: [],
      ready: false,
    };
  }
  if (found.error) {
    return {
      item: item({ id, ownership, path: targetPath, state: "error", title, type: "unavailable", detail: errorText(found.error, "无法读取目录") }),
      entries: [],
      ready: false,
    };
  }
  const type = itemType(found.stat);
  if (type !== "directory") {
    return {
      item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: type === "symbolic-link" ? "不能跟随符号链接进行检查。" : "应为普通目录。" }),
      entries: [],
      ready: false,
    };
  }
  try {
    const entries = await fsOps.readdir(targetPath, { withFileTypes: true });
    return {
      item: item({ id, ownership, path: targetPath, stat: found.stat, title, detail: "目录可读取。" }),
      entries: entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
      ready: true,
    };
  } catch (error) {
    return {
      item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: errorText(error, "无法列出目录内容") }),
      entries: [],
      ready: false,
    };
  }
}

function keysSummary(value, limit = 12) {
  const keys = Object.keys(plainObject(value) || {}).sort((left, right) => left.localeCompare(right, "en"));
  return { count: keys.length, shown: keys.slice(0, limit), truncated: keys.length > limit };
}

function hookCount(value) {
  const hooks = plainObject(value);
  if (!hooks) return { events: [], total: 0, suzu: 0 };
  let total = 0;
  let suzu = 0;
  const events = [];
  for (const [event, rows] of Object.entries(hooks)) {
    if (!Array.isArray(rows)) continue;
    events.push(event);
    for (const row of rows) {
      const commands = Array.isArray(row?.hooks) ? row.hooks : [];
      for (const command of commands) {
        total += 1;
        const args = Array.isArray(command?.args) ? command.args.map((entry) => String(entry || "")) : [];
        if (args.includes("--suzu-lives-hook") || args.some((entry) => entry.includes("suzu-lives:project-hook:"))) suzu += 1;
      }
    }
  }
  return { events: events.sort((left, right) => left.localeCompare(right, "en")), total, suzu };
}

function claudeSettingsMetadata(value) {
  const source = plainObject(value) || {};
  const env = plainObject(source.env) || {};
  const envKeys = Object.keys(env).sort((left, right) => left.localeCompare(right, "en"));
  const managedEnvKeys = envKeys.filter((key) => MANAGED_CLAUDE_API_ENV_KEYS.has(key));
  const customEnvKeys = envKeys.filter((key) => !MANAGED_CLAUDE_API_ENV_KEYS.has(key));
  const hooks = hookCount(source.hooks);
  const permissions = plainObject(source.permissions) || {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow.length : 0;
  const deny = Array.isArray(permissions.deny) ? permissions.deny.length : 0;
  const mcpServers = keysSummary(source.mcpServers, 8);
  return {
    keys: keysSummary(source),
    env: { customKeys: customEnvKeys.slice(0, 12), managedKeys: managedEnvKeys.slice(0, 12), total: envKeys.length },
    hooks,
    mcpServers,
    permissions: { allow, deny },
  };
}

function jsonDetail(metadata, { project = false } = {}) {
  const fields = metadata.keys.shown.join("、") || "无顶层字段";
  const suffix = metadata.keys.truncated ? "等" : "";
  const hookDetail = metadata.hooks.total
    ? `Hook ${metadata.hooks.total} 个${project && metadata.hooks.suzu ? `（其中 Suzu ${metadata.hooks.suzu} 个）` : ""}`
    : "没有 Hook";
  const permissions = metadata.permissions.allow || metadata.permissions.deny
    ? `权限规则 ${metadata.permissions.allow + metadata.permissions.deny} 条`
    : "";
  return [
    `JSON 有效；字段：${fields}${suffix}。`,
    metadata.env.total ? `环境变量 ${metadata.env.total} 项（仅显示键名，不显示值）。` : "",
    hookDetail,
    permissions,
    metadata.mcpServers.count ? `MCP ${metadata.mcpServers.count} 个。` : "",
  ].filter(Boolean).join(" ");
}

function genericJsonDetail(metadata) {
  const fields = metadata.keys.shown.join("、") || "无顶层字段";
  return `JSON 有效；字段：${fields}${metadata.keys.truncated ? "等" : ""}。`;
}

async function inspectJsonFile(fsOps, targetPath, {
  id,
  ownership = "managed",
  required = false,
  title,
  project = false,
  claude = false,
  validate = null,
} = {}) {
  const found = await lstat(fsOps, targetPath);
  if (found.missing) {
    return { item: item({ id, ownership, path: targetPath, state: required ? "warning" : "missing", title, type: "missing", detail: required ? "未找到，可能被移动或删除。" : "未创建。" }), value: null };
  }
  if (found.error) {
    return { item: item({ id, ownership, path: targetPath, state: "error", title, type: "unavailable", detail: errorText(found.error, "无法读取文件") }), value: null };
  }
  const type = itemType(found.stat);
  if (type !== "file") {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: type === "symbolic-link" ? "不能跟随符号链接读取配置。" : "应为普通文件。" }), value: null };
  }
  if (found.stat.size > MAX_JSON_BYTES) {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "warning", title, detail: `文件超过 ${MAX_JSON_BYTES / 1024 / 1024} MB，未读取内容。` }), value: null };
  }
  let value;
  try {
    value = JSON.parse((await fsOps.readFile(targetPath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: "不是有效的 JSON 对象。" }), value: null };
  }
  const verified = await lstat(fsOps, targetPath);
  if (!verified.stat || itemType(verified.stat) !== "file") {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "warning", title, detail: "读取期间文件发生变化，结果未采用。" }), value: null };
  }
  if (verified.stat.size !== found.stat.size || verified.stat.mtimeMs !== found.stat.mtimeMs) {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "warning", title, detail: "读取期间文件发生变化，结果未采用。" }), value: null };
  }
  if (!plainObject(value)) {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: "根节点必须是 JSON 对象。" }), value: null };
  }
  const validation = typeof validate === "function" ? validate(value) : { valid: true };
  if (!validation?.valid) {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: clean(validation?.detail) || "内容格式不符合预期。" }), value: null };
  }
  const metadata = claude ? claudeSettingsMetadata(value) : { keys: keysSummary(value) };
  return {
    item: item({
      id,
      ownership: validation?.ownership || ownership,
      path: targetPath,
      stat: found.stat,
      title,
      detail: clean(validation?.detail) || (claude ? jsonDetail(metadata, { project }) : genericJsonDetail(metadata)),
      metadata,
    }),
    value,
  };
}

async function inspectRegularFile(fsOps, targetPath, { id, ownership = "managed", required = false, title } = {}) {
  const found = await lstat(fsOps, targetPath);
  if (found.missing) return item({ id, ownership, path: targetPath, state: required ? "warning" : "missing", title, type: "missing", detail: required ? "未找到，可能被移动或删除。" : "未创建。" });
  if (found.error) return item({ id, ownership, path: targetPath, state: "error", title, type: "unavailable", detail: errorText(found.error, "无法读取文件") });
  const type = itemType(found.stat);
  return item({
    id,
    ownership,
    path: targetPath,
    stat: found.stat,
    state: type === "file" ? "ok" : "error",
    title,
    detail: type === "file" ? "普通文件可读取。" : type === "symbolic-link" ? "不能跟随符号链接进行检查。" : "应为普通文件。",
  });
}

function genericEntry({ error = null, id, label, ownership, stat, targetPath }) {
  const type = itemType(stat);
  return item({
    id,
    ownership,
    path: targetPath,
    stat,
    state: error ? "error" : type === "symbolic-link" ? "warning" : ownership === "external" ? "notice" : "ok",
    title: label,
    detail: error ? errorText(error, "无法读取目录项") : type === "symbolic-link"
      ? "符号链接未跟随，需确认它是否符合预期。"
      : ownership === "external" ? "由软件外部加入；未作修改。" : "已发现。",
  });
}

async function itemsFromEntries(fsOps, directory, entries, {
  idPrefix,
  ownershipFor = () => "external",
  titleFor = (name) => name,
} = {}) {
  const list = [];
  const limited = entries.slice(0, MAX_DIRECTORY_ITEMS);
  for (const entry of limited) {
    const targetPath = directChild(directory, entry.name);
    if (!targetPath) continue;
    const found = await lstat(fsOps, targetPath);
    list.push(genericEntry({
      error: found.error,
      id: `${idPrefix}:${entry.name}`,
      label: titleFor(entry.name),
      ownership: ownershipFor(entry.name),
      stat: found.stat,
      targetPath,
    }));
  }
  if (entries.length > limited.length) {
    list.push(item({
      id: `${idPrefix}:truncated`,
      ownership: "managed",
      path: directory,
      state: "warning",
      type: "directory",
      title: "目录内容过多",
      detail: `为避免影响软件运行，仅列出了前 ${MAX_DIRECTORY_ITEMS} 项。`,
    }));
  }
  return list;
}

function contactMetadata(value, directoryName) {
  const id = clean(value?.id).toLowerCase();
  const name = clean(value?.name);
  const agentId = clean(value?.agentId);
  if (!CONTACT_ID_PATTERN.test(id) || id !== directoryName.toLowerCase() || !name || !AGENT_ID_PATTERN.test(agentId)) {
    return { valid: false, detail: "联系人元数据缺少有效的 id、备注或 agentId。" };
  }
  return { valid: true, agentId, detail: "联系人元数据有效。" };
}

async function inspectClaudeDirectory(fsOps, targetPath, contactId) {
  const result = await inspectDirectory(fsOps, targetPath, { id: `contact:${contactId}:claude`, title: ".claude", ownership: "shared", required: true });
  const items = [result.item];
  if (!result.ready) return items;
  const names = new Set(result.entries.map((entry) => entry.name));
  const settingsPath = path.join(targetPath, "settings.json");
  const settings = await inspectJsonFile(fsOps, settingsPath, { id: `contact:${contactId}:claude-settings`, ownership: "shared", required: true, title: ".claude/settings.json", claude: true, project: true });
  items.push(settings.item);
  if (names.has("settings.local.json")) {
    const local = await inspectJsonFile(fsOps, path.join(targetPath, "settings.local.json"), { id: `contact:${contactId}:claude-local-settings`, ownership: "external", title: ".claude/settings.local.json", claude: true, project: true });
    items.push(local.item);
  }
  const skills = result.entries.find((entry) => entry.name === "skills");
  if (skills) {
    const skillDirectory = await inspectDirectory(fsOps, path.join(targetPath, "skills"), { id: `contact:${contactId}:skills`, title: ".claude/skills", ownership: "shared" });
    items.push(skillDirectory.item);
    if (skillDirectory.ready) {
      items.push(...await itemsFromEntries(fsOps, path.join(targetPath, "skills"), skillDirectory.entries, {
        idPrefix: `contact:${contactId}:skill`,
        ownershipFor: (name) => name.startsWith("suzu-lives-") ? "managed" : "external",
        titleFor: (name) => `.claude/skills/${name}`,
      }));
    }
  }
  const extras = result.entries.filter((entry) => !["settings.json", "settings.local.json", "skills"].includes(entry.name));
  items.push(...await itemsFromEntries(fsOps, targetPath, extras, {
    idPrefix: `contact:${contactId}:claude-extra`,
    titleFor: (name) => `.claude/${name}`,
  }));
  return items;
}

async function inspectContactProject(fsOps, root, entry) {
  const projectPath = directChild(root, entry.name);
  const directory = await inspectDirectory(fsOps, projectPath, { id: `contact:${entry.name}`, title: `联系人项目：${entry.name}`, ownership: "managed", required: true });
  const items = [directory.item];
  const output = { agentId: "", items };
  if (!directory.ready) return output;
  if (!CONTACT_ID_PATTERN.test(entry.name)) {
    directory.item.ownership = "external";
    directory.item.state = "notice";
    directory.item.detail = "不是 Suzu 的联系人目录命名；由软件外部加入。";
    return output;
  }
  items.push(await inspectRegularFile(fsOps, path.join(projectPath, "CLAUDE.md"), { id: `contact:${entry.name}:instructions`, ownership: "managed", required: true, title: "CLAUDE.md" }));
  const metadataDirectory = await inspectDirectory(fsOps, path.join(projectPath, ".suzu-lives"), { id: `contact:${entry.name}:metadata-directory`, title: ".suzu-lives", ownership: "managed", required: true });
  items.push(metadataDirectory.item);
  if (metadataDirectory.ready) {
    const metadata = await inspectJsonFile(fsOps, path.join(projectPath, ".suzu-lives", "contact.json"), {
      id: `contact:${entry.name}:metadata`,
      ownership: "managed",
      required: true,
      title: ".suzu-lives/contact.json",
      validate: (value) => contactMetadata(value, entry.name),
    });
    items.push(metadata.item);
    output.agentId = clean(metadata.value?.agentId);
    const extras = metadataDirectory.entries.filter((child) => child.name !== "contact.json");
    items.push(...await itemsFromEntries(fsOps, path.join(projectPath, ".suzu-lives"), extras, {
      idPrefix: `contact:${entry.name}:metadata-extra`,
      titleFor: (name) => `.suzu-lives/${name}`,
    }));
  }
  items.push(...await inspectClaudeDirectory(fsOps, path.join(projectPath, ".claude"), entry.name));
  const extras = directory.entries.filter((child) => !["CLAUDE.md", ".claude", ".suzu-lives"].includes(child.name));
  items.push(...await itemsFromEntries(fsOps, projectPath, extras, {
    idPrefix: `contact:${entry.name}:external`,
    titleFor: (name) => `${entry.name}/${name}`,
  }));
  return output;
}

async function scanContacts(fsOps, contactsRoot) {
  const source = absolutePath(contactsRoot);
  const directory = source
    ? await inspectDirectory(fsOps, source, { id: "contacts-root", title: "Agent 工作目录", ownership: "managed" })
    : { item: item({ id: "contacts-root", title: "Agent 工作目录", ownership: "managed", state: "missing", type: "missing", detail: "尚未在设置中选择。" }), entries: [], ready: false };
  const section = { id: "contacts", title: "联系人项目", detail: "每个联系人项目的受管文件、Claude 配置和外部加入项。", items: [directory.item] };
  const agentIds = new Set();
  if (!directory.ready) return { section, agentIds };
  const entries = directory.entries.slice(0, MAX_DIRECTORY_ITEMS);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      const targetPath = directChild(source, entry.name);
      if (!targetPath) continue;
      const found = await lstat(fsOps, targetPath);
      section.items.push(genericEntry({ error: found.error, id: `contacts-root:external:${entry.name}`, label: entry.name, ownership: "external", stat: found.stat, targetPath }));
      continue;
    }
    const result = await inspectContactProject(fsOps, source, entry);
    section.items.push(...result.items);
    if (AGENT_ID_PATTERN.test(result.agentId)) agentIds.add(result.agentId);
  }
  if (directory.entries.length > entries.length) {
    section.items.push(item({ id: "contacts-root:truncated", title: "联系人项目过多", ownership: "managed", state: "warning", path: source, type: "directory", detail: `为避免影响软件运行，仅列出了前 ${MAX_DIRECTORY_ITEMS} 个项目。` }));
  }
  return { section, agentIds };
}

async function scanDataRoot(fsOps, dataRoot, contactAgentIds) {
  const source = absolutePath(dataRoot);
  const directory = source
    ? await inspectDirectory(fsOps, source, { id: "data-root", title: "Suzu Lives 数据目录", ownership: "managed", required: true })
    : { item: item({ id: "data-root", title: "Suzu Lives 数据目录", ownership: "managed", state: "error", type: "missing", detail: "无法定位软件数据目录。" }), entries: [], ready: false };
  const section = { id: "data", title: "Suzu 软件数据", detail: "软件数据、运行时目录和根目录的外部加入项。", items: [directory.item] };
  if (!directory.ready) return section;
  const settings = await inspectJsonFile(fsOps, path.join(source, "settings.json"), { id: "data-root:settings", title: "Suzu 设置文件", ownership: "managed", required: true });
  section.items.push(settings.item);
  const entries = directory.entries.slice(0, MAX_DIRECTORY_ITEMS);
  for (const entry of entries) {
    const targetPath = directChild(source, entry.name);
    if (!targetPath) continue;
    if (entry.name === "settings.json") continue;
    const ownership = SUZU_DATA_ENTRIES.has(entry.name)
      ? "managed"
      : ELECTRON_PROFILE_ENTRIES.has(entry.name)
        ? "runtime"
        : "external";
    const found = await lstat(fsOps, targetPath);
    section.items.push(genericEntry({ error: found.error, id: `data-root:${entry.name}`, label: entry.name, ownership, stat: found.stat, targetPath }));
  }
  if (directory.entries.length > entries.length) {
    section.items.push(item({ id: "data-root:truncated", title: "数据目录内容过多", ownership: "managed", state: "warning", path: source, type: "directory", detail: `为避免影响软件运行，仅列出了前 ${MAX_DIRECTORY_ITEMS} 项。` }));
  }
  const agentDirectory = await inspectDirectory(fsOps, path.join(source, "agents"), { id: "agents-directory", title: "Agent 数据目录", ownership: "managed" });
  if (agentDirectory.ready) {
    const entries = agentDirectory.entries.slice(0, MAX_DIRECTORY_ITEMS);
    for (const entry of entries) {
      const targetPath = directChild(path.join(source, "agents"), entry.name);
      if (!targetPath) continue;
      const found = await lstat(fsOps, targetPath);
      const related = contactAgentIds.has(entry.name);
      section.items.push(item({
        id: `agent-data:${entry.name}`,
        ownership: related ? "managed" : "external",
        path: targetPath,
        stat: found.stat,
        state: related ? "ok" : "warning",
        title: `Agent 数据：${entry.name}`,
        detail: related ? "已关联到联系人项目。" : "未与当前联系人元数据关联；可能是外部数据或已删除联系人的残留。",
      }));
    }
  }
  const capabilityDirectory = await inspectDirectory(fsOps, path.join(source, "capabilities"), { id: "capabilities-directory", title: "功能数据目录", ownership: "managed" });
  if (capabilityDirectory.ready) {
    const entries = capabilityDirectory.entries.slice(0, MAX_DIRECTORY_ITEMS);
    for (const entry of entries) {
      const targetPath = directChild(path.join(source, "capabilities"), entry.name);
      if (!targetPath) continue;
      const found = await lstat(fsOps, targetPath);
      const ownership = SUZU_CAPABILITY_ENTRIES.has(entry.name) ? "managed" : "external";
      section.items.push(genericEntry({ error: found.error, id: `capability-data:${entry.name}`, label: `功能数据：${entry.name}`, ownership, stat: found.stat, targetPath }));
    }
  }
  return section;
}

async function scanGlobalClaude(fsOps, homeDirectory) {
  const home = absolutePath(homeDirectory);
  const section = { id: "claude-global", title: "本机 Claude 配置", detail: "用户级 Claude 配置会影响这台电脑上的所有 Claude 项目；配置值和密钥不会显示。", items: [] };
  if (!home) {
    section.items.push(item({ id: "home-directory", title: "本机用户目录", ownership: "external", state: "error", type: "missing", detail: "无法定位本机用户目录。" }));
    return section;
  }
  const claude = await inspectDirectory(fsOps, path.join(home, ".claude"), { id: "global-claude-directory", title: "%USERPROFILE%/.claude", ownership: "external" });
  section.items.push(claude.item);
  const deviceSettings = await inspectJsonFile(fsOps, path.join(home, ".claude", "settings.json"), {
    id: "global-claude-settings",
    title: "%USERPROFILE%/.claude/settings.json",
    ownership: "external",
    claude: true,
  });
  if (deviceSettings.value && deviceSettings.item.metadata?.env?.managedKeys?.length) deviceSettings.item.ownership = "shared";
  section.items.push(deviceSettings.item);
  const userConfig = await inspectJsonFile(fsOps, path.join(home, ".claude.json"), {
    id: "global-claude-user-config",
    title: "%USERPROFILE%/.claude.json",
    ownership: "external",
  });
  section.items.push(userConfig.item);
  if (!claude.ready) return section;
  const knownNames = new Set(["settings.json", "settings.local.json", "CLAUDE.md", "skills", "commands", "plugins"]);
  const entries = claude.entries.filter((entry) => knownNames.has(entry.name) || !CLAUDE_RUNTIME_ENTRIES.has(entry.name));
  for (const entry of entries) {
    if (entry.name === "settings.json") continue;
    const targetPath = directChild(path.join(home, ".claude"), entry.name);
    if (!targetPath) continue;
    if (entry.name === "settings.local.json") {
      const local = await inspectJsonFile(fsOps, targetPath, { id: "global-claude-local-settings", title: "%USERPROFILE%/.claude/settings.local.json", ownership: "external", claude: true });
      section.items.push(local.item);
      continue;
    }
    const found = await lstat(fsOps, targetPath);
    section.items.push(genericEntry({ error: found.error, id: `global-claude:${entry.name}`, label: `%USERPROFILE%/.claude/${entry.name}`, ownership: "external", stat: found.stat, targetPath }));
  }
  return section;
}

function summary(sections) {
  const items = sections.flatMap((section) => section.items);
  const errors = items.filter((entry) => entry.state === "error").length;
  const warnings = items.filter((entry) => entry.state === "warning").length;
  const external = items.filter((entry) => entry.ownership === "external").length;
  const managed = items.filter((entry) => entry.ownership === "managed").length;
  return {
    status: errors ? "error" : warnings ? "warning" : "ready",
    errors,
    warnings,
    external,
    managed,
    total: items.length,
  };
}

/**
 * Read-only inspection of Suzu and Claude configuration boundaries.  It never
 * follows symbolic links, executes hooks, writes files, or returns config values.
 */
export function createSystemStatusService({
  dataRoot = "",
  homeDirectory = os.homedir,
  settingsService = null,
  fsOps = fs,
} = {}) {
  const resolvedDataRoot = () => typeof dataRoot === "function" ? clean(dataRoot()) : clean(dataRoot);
  const scan = async () => {
    const settings = typeof settingsService?.load === "function" ? settingsService.load() : {};
    const contacts = await scanContacts(fsOps, settings?.contactsRoot);
    const [data, globalClaude] = await Promise.all([
      scanDataRoot(fsOps, resolvedDataRoot(), contacts.agentIds),
      scanGlobalClaude(fsOps, typeof homeDirectory === "function" ? homeDirectory() : homeDirectory),
    ]);
    const sections = [data, contacts.section, globalClaude];
    return { checkedAt: new Date().toISOString(), sections, summary: summary(sections) };
  };
  return { scan };
}
