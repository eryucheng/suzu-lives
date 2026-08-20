import fs from "node:fs/promises";
import path from "node:path";

import { MANAGED_CONTACTS_DIRECTORY } from "./contact-projects.mjs";

const MAX_DIRECTORY_ITEMS = 180;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const CONTACT_ID_PATTERN = /^contact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/iu;

const SUZU_DATA_ENTRIES = new Set([
  "SUZU.md", "agent-runtime", "agents", "automation", "blob_storage", "capabilities", "connections", "contacts", "diagnostics", "external-capabilities", "settings.json", "software-assistant", "voice-message", "wechat-link",
]);
const ELECTRON_PROFILE_ENTRIES = new Set([
  "Cache", "Code Cache", "DawnGraphiteCache", "DawnWebGPUCache", "Dictionaries", "GPUCache", "Local Storage", "Network", "Session Storage", "Shared Dictionary", "SharedStorage", "DevToolsActivePort", "DIPS", "Local State", "Preferences",
]);
const SUZU_CAPABILITY_ENTRIES = new Set([
  "computer-camera", "image-generation", "image-vision", "mail-bridge", "managed-registrations-v1.json", "phone-camera", "time-awareness", "video-understanding", "voice-message", "web-browser",
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

function entryType(entry) {
  if (entry?.isSymbolicLink?.()) return "symbolic-link";
  if (entry?.isDirectory?.()) return "directory";
  if (entry?.isFile?.()) return "file";
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
      item: item({ id, ownership, path: targetPath, state: required ? "warning" : "missing", title, type: "missing", detail: required ? "未找到，可能被移动或删除。" : "尚未创建。" }),
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

async function inspectRegularFile(fsOps, targetPath, { id, ownership = "managed", required = false, title } = {}) {
  const found = await lstat(fsOps, targetPath);
  if (found.missing) return item({ id, ownership, path: targetPath, state: required ? "warning" : "missing", title, type: "missing", detail: required ? "未找到，可能被移动或删除。" : "尚未创建。" });
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

async function inspectJsonFile(fsOps, targetPath, { id, ownership = "managed", required = false, title, validate = null } = {}) {
  const found = await lstat(fsOps, targetPath);
  if (found.missing) return { item: item({ id, ownership, path: targetPath, state: required ? "warning" : "missing", title, type: "missing", detail: required ? "未找到，可能被移动或删除。" : "尚未创建。" }), value: null };
  if (found.error) return { item: item({ id, ownership, path: targetPath, state: "error", title, type: "unavailable", detail: errorText(found.error, "无法读取 JSON 文件") }), value: null };
  if (itemType(found.stat) !== "file") {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: itemType(found.stat) === "symbolic-link" ? "不能跟随符号链接读取配置。" : "应为普通文件。" }), value: null };
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
  if (!verified.stat || itemType(verified.stat) !== "file" || verified.stat.size !== found.stat.size || verified.stat.mtimeMs !== found.stat.mtimeMs) {
    return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "warning", title, detail: "读取期间文件发生变化，结果未采用。" }), value: null };
  }
  if (!plainObject(value)) return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: "根节点必须是 JSON 对象。" }), value: null };
  const validation = typeof validate === "function" ? validate(value) : { valid: true };
  if (!validation?.valid) return { item: item({ id, ownership, path: targetPath, stat: found.stat, state: "error", title, detail: clean(validation?.detail) || "内容格式不符合预期。" }), value: null };
  return {
    item: item({ id, ownership: validation?.ownership || ownership, path: targetPath, stat: found.stat, title, detail: clean(validation?.detail) || "JSON 有效；内容不会显示。", metadata: { keys: Object.keys(value).sort().slice(0, 12) } }),
    value,
  };
}

function genericEntry({ error = null, id, label, ownership, stat, targetPath, type = "" }) {
  const resolvedType = type || itemType(stat);
  return item({
    id,
    ownership,
    path: targetPath,
    stat,
    type: resolvedType,
    state: error ? "error" : resolvedType === "symbolic-link" ? "warning" : ownership === "external" ? "notice" : "ok",
    title: label,
    detail: error ? errorText(error, "无法读取目录项") : resolvedType === "symbolic-link"
      ? "符号链接未跟随，需确认它是否符合预期。"
      : ownership === "external" ? "由软件外部加入；未作修改。" : "已发现。",
  });
}

async function itemsFromEntries(fsOps, directory, entries, { idPrefix, ownershipFor = () => "external", titleFor = (name) => name } = {}) {
  const items = [];
  const limited = entries.slice(0, MAX_DIRECTORY_ITEMS);
  for (const entry of limited) {
    const targetPath = directChild(directory, entry.name);
    if (!targetPath) continue;
    const found = await lstat(fsOps, targetPath);
    items.push(genericEntry({ error: found.error, id: `${idPrefix}:${entry.name}`, label: titleFor(entry.name), ownership: ownershipFor(entry.name), stat: found.stat, targetPath }));
  }
  if (entries.length > limited.length) {
    items.push(item({ id: `${idPrefix}:truncated`, ownership: "managed", path: directory, state: "warning", type: "directory", title: "目录内容过多", detail: `为避免影响软件运行，仅列出了前 ${MAX_DIRECTORY_ITEMS} 项。` }));
  }
  return items;
}

function contactMetadata(value, directoryName) {
  const id = clean(value?.id).toLowerCase();
  const name = clean(value?.name);
  const agentId = clean(value?.agentId);
  if (!CONTACT_ID_PATTERN.test(id) || id !== directoryName.toLowerCase() || !name || !AGENT_ID_PATTERN.test(agentId)) {
    return { valid: false, detail: "联系人元数据缺少有效的 id、备注或 agentId。" };
  }
  return { valid: true, agentId, detail: "联系人元数据有效；内容不会显示。" };
}

async function inspectContactProject(fsOps, root, entry) {
  const projectPath = directChild(root, entry.name);
  const directory = await inspectDirectory(fsOps, projectPath, { id: `contact:${entry.name}`, title: `联系人工作区：${entry.name}`, ownership: "managed", required: true });
  const items = [directory.item];
  const output = { agentId: "", items };
  if (!directory.ready) return output;
  if (!CONTACT_ID_PATTERN.test(entry.name)) {
    directory.item.ownership = "external";
    directory.item.state = "notice";
    directory.item.detail = "不是 Suzu 的联系人目录命名；由软件外部加入。";
    return output;
  }
  items.push(await inspectRegularFile(fsOps, path.join(projectPath, "SUZU.md"), { id: `contact:${entry.name}:instructions`, ownership: "managed", required: true, title: "SUZU.md" }));
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
    items.push(...await itemsFromEntries(fsOps, path.join(projectPath, ".suzu-lives"), extras, { idPrefix: `contact:${entry.name}:metadata-extra`, titleFor: (name) => `.suzu-lives/${name}` }));
  }
  const extras = directory.entries.filter((child) => !["SUZU.md", ".suzu-lives"].includes(child.name));
  items.push(...await itemsFromEntries(fsOps, projectPath, extras, { idPrefix: `contact:${entry.name}:external`, titleFor: (name) => `${entry.name}/${name}` }));
  return output;
}

async function scanContacts(fsOps, contactsRoot) {
  const source = absolutePath(contactsRoot);
  const directory = source
    ? await inspectDirectory(fsOps, source, { id: "contacts-root", title: "受管联系人资料目录", ownership: "managed" })
    : { item: item({ id: "contacts-root", title: "受管联系人资料目录", ownership: "managed", state: "missing", type: "missing", detail: "软件数据目录尚未准备好。" }), entries: [], ready: false };
  const section = { id: "contacts", title: "联系人工作区", detail: "每位联系人的 Suzu 资料、元数据及外部加入项。", items: [directory.item] };
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
    section.items.push(item({ id: "contacts-root:truncated", title: "联系人工作区过多", ownership: "managed", state: "warning", path: source, type: "directory", detail: `为避免影响软件运行，仅列出了前 ${MAX_DIRECTORY_ITEMS} 个工作区。` }));
  }
  return { section, agentIds };
}

async function scanDataRoot(fsOps, dataRoot, contactAgentIds) {
  const source = absolutePath(dataRoot);
  const directory = source
    ? await inspectDirectory(fsOps, source, { id: "data-root", title: "Suzu Lives 数据目录", ownership: "managed", required: true })
    : { item: item({ id: "data-root", title: "Suzu Lives 数据目录", ownership: "managed", state: "error", type: "missing", detail: "无法定位软件数据目录。" }), entries: [], ready: false };
  const section = { id: "data", title: "Suzu 软件数据", detail: "软件数据、Suzu Agent Core 目录和根目录的外部加入项。", items: [directory.item] };
  if (!directory.ready) return section;
  section.items.push((await inspectJsonFile(fsOps, path.join(source, "settings.json"), { id: "data-root:settings", title: "Suzu 设置文件", ownership: "managed", required: true })).item);
  section.items.push(await inspectRegularFile(fsOps, path.join(source, "SUZU.md"), { id: "data-root:global-instructions", title: "全局 SUZU.md", ownership: "managed" }));
  const entries = directory.entries.slice(0, MAX_DIRECTORY_ITEMS);
  for (const entry of entries) {
    const targetPath = directChild(source, entry.name);
    if (!targetPath || ["settings.json", "SUZU.md"].includes(entry.name)) continue;
    const ownership = SUZU_DATA_ENTRIES.has(entry.name) ? "managed" : ELECTRON_PROFILE_ENTRIES.has(entry.name) ? "runtime" : "external";
    const found = await lstat(fsOps, targetPath);
    section.items.push(genericEntry({ error: found.error, id: `data-root:${entry.name}`, label: entry.name, ownership, stat: found.stat, targetPath }));
  }
  const agentDirectory = await inspectDirectory(fsOps, path.join(source, "agents"), { id: "agents-directory", title: "Agent 数据目录", ownership: "managed" });
  if (agentDirectory.ready) {
    for (const entry of agentDirectory.entries.slice(0, MAX_DIRECTORY_ITEMS)) {
      const targetPath = directChild(path.join(source, "agents"), entry.name);
      if (!targetPath) continue;
      const found = await lstat(fsOps, targetPath);
      const related = contactAgentIds.has(entry.name);
      section.items.push(item({ id: `agent-data:${entry.name}`, ownership: related ? "managed" : "external", path: targetPath, stat: found.stat, state: related ? "ok" : "warning", title: `Agent 数据：${entry.name}`, detail: related ? "已关联到联系人工作区。" : "未与当前联系人元数据关联；可能是外部数据或已删除联系人的残留。" }));
    }
  }
  const capabilityDirectory = await inspectDirectory(fsOps, path.join(source, "capabilities"), { id: "capabilities-directory", title: "功能数据目录", ownership: "managed" });
  if (capabilityDirectory.ready) {
    for (const entry of capabilityDirectory.entries.slice(0, MAX_DIRECTORY_ITEMS)) {
      const targetPath = directChild(path.join(source, "capabilities"), entry.name);
      if (!targetPath) continue;
      const found = await lstat(fsOps, targetPath);
      section.items.push(genericEntry({ error: found.error, id: `capability-data:${entry.name}`, label: `功能数据：${entry.name}`, ownership: SUZU_CAPABILITY_ENTRIES.has(entry.name) ? "managed" : "external", stat: found.stat, targetPath }));
    }
  }
  return section;
}

async function scanSuzuAgentCore(fsOps, dataRoot) {
  const root = absolutePath(dataRoot);
  const runtimeHome = root ? path.join(root, "agent-runtime", "core") : "";
  const section = { id: "agent-core", title: "Suzu Agent Core", detail: "仅检查 Suzu 管理的 Agent Core 文件结构；不会显示凭据内容、请求模型或读取其他 Agent 工具目录。", items: [] };
  if (!runtimeHome) {
    section.items.push(item({ id: "agent-core-directory", title: "Suzu Agent Core 目录", ownership: "managed", state: "missing", type: "missing", detail: "尚未定位 Suzu 数据目录。" }));
    return section;
  }
  const runtime = await inspectDirectory(fsOps, runtimeHome, { id: "agent-core-directory", title: "agent-runtime/core", ownership: "managed" });
  section.items.push(runtime.item);
  if (!runtime.ready) return section;
  section.items.push(await inspectRegularFile(fsOps, path.join(runtimeHome, "settings.yaml"), { id: "agent-core:settings", title: "Agent Core settings.yaml", ownership: "managed" }));
  section.items.push(await inspectRegularFile(fsOps, path.join(runtimeHome, ".credentials.yaml"), { id: "agent-core:credentials", title: "Suzu 本机模型凭据（内容不显示）", ownership: "managed" }));
  section.items.push(await inspectRegularFile(fsOps, path.join(runtimeHome, "AGENTS.md"), { id: "agent-core:instruction-bridge", title: "Suzu 全局指令桥接（内容不显示）", ownership: "managed" }));
  section.items.push((await inspectDirectory(fsOps, path.join(runtimeHome, ".agent-presets"), { id: "agent-core:presets", title: "Suzu Agent presets", ownership: "managed" })).item);
  section.items.push(await inspectRegularFile(fsOps, path.join(runtimeHome, ".agent-presets", "suzu-companion", "agent.cordis.yml"), { id: "agent-core:companion-preset", title: "Suzu 陪伴 preset（PowerShell / 文件）", ownership: "managed" }));
  section.items.push(await inspectRegularFile(fsOps, path.join(runtimeHome, ".agent-presets", "suzu-software-assistant", "agent.cordis.yml"), { id: "agent-core:software-assistant-preset", title: "Suzu 软件助手 preset（独立会话）", ownership: "managed" }));
  return section;
}

function summary(sections) {
  const items = sections.flatMap((section) => section.items);
  const errors = items.filter((entry) => entry.state === "error").length;
  const warnings = items.filter((entry) => entry.state === "warning").length;
  const external = items.filter((entry) => entry.ownership === "external").length;
  const managed = items.filter((entry) => entry.ownership === "managed").length;
  return { status: errors ? "error" : warnings ? "warning" : "ready", errors, warnings, external, managed, total: items.length };
}

/**
 * Read-only inspection of Suzu-owned data, contact workspaces, and the local
 * Suzu Agent Core. It never follows symbolic links, reads external Agent files,
 * executes hooks, sends model requests, writes files, or returns credential values.
 */
export function createSystemStatusService({ dataRoot = "", settingsService = null, fsOps = fs } = {}) {
  const resolvedDataRoot = () => typeof dataRoot === "function" ? clean(dataRoot()) : clean(dataRoot);
  const scan = async () => {
    const settings = typeof settingsService?.load === "function" ? settingsService.load() : {};
    const root = resolvedDataRoot();
    const contactsRoot = clean(settings?.contactsRoot) || (root ? path.join(root, MANAGED_CONTACTS_DIRECTORY) : "");
    const contacts = await scanContacts(fsOps, contactsRoot);
    const [data, agentCore] = await Promise.all([
      scanDataRoot(fsOps, root, contacts.agentIds),
      scanSuzuAgentCore(fsOps, root),
    ]);
    const sections = [data, contacts.section, agentCore];
    return { checkedAt: new Date().toISOString(), sections, summary: summary(sections) };
  };
  return { scan };
}
