import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot, resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";
import {
  createVisualReferenceLibrary,
  ROLE_DIRECTORIES,
  ROLES,
  VisualReferenceError,
  writeManifestAtomic,
} from "@suzu-lives/visual-reference-library";

export class VisualReferenceManagerError extends Error {}

function clean(value) { return String(value ?? "").trim(); }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function posixRelative(root, target) { return path.relative(root, target).split(path.sep).join("/"); }

function asManagerError(error) {
  if (error instanceof VisualReferenceManagerError) return error;
  if (error instanceof VisualReferenceError) return new VisualReferenceManagerError(error.message);
  return new VisualReferenceManagerError(clean(error?.message) || "视觉参考资料库操作失败。 ");
}

function nextValue(values, index, flag) {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) throw new VisualReferenceManagerError(`${flag} 缺少值。`);
  return value;
}

export function parseVisualReferenceManagerArgs(values = []) {
  const result = { command: "", manifest: "", plan: "", query: "", role: "", limit: 20, dryRun: false };
  const options = new Set(["manifest", "plan", "query", "role", "limit", "data-root", "agent-id", "project-root"]);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (key === "dry-run") { result.dryRun = true; continue; }
      if (!options.has(key)) throw new VisualReferenceManagerError("未知选项：" + token);
      const value = nextValue(values, index, token); index += 1;
      result[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      continue;
    }
    if (!result.command) { result.command = token; continue; }
    if (result.command === "show" && !result.id) { result.id = token; continue; }
    throw new VisualReferenceManagerError("未知位置参数：" + token);
  }
  if (!["init", "apply", "list", "show", "validate"].includes(result.command)) {
    throw new VisualReferenceManagerError("命令只能是 init、apply、list、show 或 validate。 ");
  }
  const allowed = {
    init: new Set(["manifest", "dataRoot", "agentId", "projectRoot"]),
    apply: new Set(["manifest", "plan", "dryRun", "dataRoot", "agentId", "projectRoot"]),
    list: new Set(["manifest", "query", "role", "limit", "dataRoot", "agentId", "projectRoot"]),
    show: new Set(["manifest", "id", "dataRoot", "agentId", "projectRoot"]),
    validate: new Set(["manifest", "dataRoot", "agentId", "projectRoot"]),
  }[result.command];
  for (const [key, value] of Object.entries(result)) {
    const defaultValue = { plan: "", query: "", role: "", limit: 20, dryRun: false }[key];
    if (key !== "command" && key !== "manifest" && value !== undefined && value !== defaultValue && !allowed.has(key)) {
      throw new VisualReferenceManagerError(`--${key.replace(/[A-Z]/gu, (letter) => "-" + letter.toLowerCase())} 不能用于 ${result.command}。`);
    }
  }
  if (result.command === "apply" && !clean(result.plan)) throw new VisualReferenceManagerError("apply 需要 --plan。 ");
  if (result.command === "show" && !clean(result.id)) throw new VisualReferenceManagerError("show 需要 asset 或 set ID。 ");
  if (result.command === "list") {
    const limit = Number(result.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new VisualReferenceManagerError("--limit 必须在 1 到 200 之间。 ");
    result.limit = limit;
    if (result.role && !ROLES.includes(result.role)) throw new VisualReferenceManagerError("--role 必须是 identity、location、object 或 style。 ");
  }
  return result;
}

export function resolveVisualReferenceManifest(agentRoot, configured = "") {
  const rawRoot = clean(agentRoot);
  if (!rawRoot) throw new VisualReferenceManagerError("缺少当前 Agent 数据目录。 ");
  const root = path.resolve(rawRoot);
  const target = clean(configured)
    ? path.resolve(root, clean(configured))
    : path.join(root, "visual-references", "manifest.json");
  if (!inside(root, target) || path.basename(target).toLowerCase() !== "manifest.json") {
    throw new VisualReferenceManagerError("--manifest 必须是当前 Agent 的 Suzu Lives 数据目录内的 manifest.json。 ");
  }
  return target;
}

async function readySnapshot(library) {
  const snapshot = await library.snapshot();
  if (snapshot.status === "invalid") throw new VisualReferenceManagerError(snapshot.message || "视觉参考资料库无效。 ");
  return snapshot;
}

async function initialize(library, manifestPath) {
  const root = path.dirname(manifestPath);
  const created = [];
  await fs.mkdir(root, { recursive: true });
  for (const directory of Object.values(ROLE_DIRECTORIES)) {
    const target = path.join(root, directory);
    try { await fs.access(target); } catch { await fs.mkdir(target, { recursive: true }); created.push(target); }
  }
  try {
    await fs.access(manifestPath);
    await readySnapshot(library);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeManifestAtomic(root, { version: 1, assets: {}, sets: {} });
    created.push(manifestPath);
  }
  return { status: "ready", manifest: manifestPath, created };
}

function listLibrary(snapshot, manifestPath, { query = "", role = "", limit = 20 } = {}) {
  const terms = clean(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (value) => !terms.length || terms.every((term) => value.toLocaleLowerCase().includes(term));
  const setDescriptions = new Map(snapshot.sets.map((item) => [item.id, item.description]));
  const assets = snapshot.assets.filter((item) => {
    if (role && item.role !== role) return false;
    return matches([item.id, item.description, ...(item.preserve || []), ...(item.ignore || []), ...(item.sets || []), ...(item.sets || []).map((id) => setDescriptions.get(id) || "")].join(" "));
  });
  const sets = snapshot.sets.filter((item) => matches([item.id, item.description].join(" ")));
  return {
    status: "ok",
    manifest: manifestPath,
    asset_count: snapshot.assets.length,
    set_count: snapshot.sets.length,
    query: clean(query),
    role: role || null,
    matched_asset_count: assets.length,
    matched_set_count: sets.length,
    assets: assets.slice(0, limit).map((item) => ({ id: item.id, role: item.role, description: item.description, sets: item.sets })),
    sets: sets.slice(0, limit),
    truncated: assets.length > limit || sets.length > limit,
  };
}

async function showLibraryItem(library, snapshot, libraryRoot, id) {
  const asset = snapshot.assets.find((item) => item.id === id);
  if (asset) {
    const filePath = await library.assetPath(id);
    return { status: "ok", type: "asset", id, path: posixRelative(libraryRoot, filePath), role: asset.role, description: asset.description, preserve: asset.preserve, ignore: asset.ignore, sets: asset.sets };
  }
  const set = snapshot.sets.find((item) => item.id === id);
  if (set) return { status: "ok", type: "set", id, description: set.description, assets: set.assets };
  throw new VisualReferenceManagerError("找不到 asset 或 set：" + id);
}

async function readPlan(planPath) {
  try {
    const parsed = JSON.parse((await fs.readFile(path.resolve(planPath), "utf8")).replace(/^\uFEFF/u, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new VisualReferenceManagerError("维护计划 JSON 顶层必须是对象。 ");
    return parsed;
  } catch (error) {
    if (error instanceof VisualReferenceManagerError) throw error;
    if (error instanceof SyntaxError) throw new VisualReferenceManagerError("维护计划不是有效 JSON。 ");
    if (error?.code === "ENOENT") throw new VisualReferenceManagerError("找不到维护计划：" + planPath);
    throw new VisualReferenceManagerError("无法读取维护计划：" + clean(error?.message));
  }
}

export async function runVisualReferenceManager({ agentRoot, args } = {}) {
  const manifestPath = resolveVisualReferenceManifest(agentRoot, args.manifest);
  const libraryRoot = path.dirname(manifestPath);
  const library = createVisualReferenceLibrary({ libraryRoot });
  try {
    if (args.command === "init") return await initialize(library, manifestPath);
    const snapshot = await readySnapshot(library);
    if (args.command === "list") return listLibrary(snapshot, manifestPath, args);
    if (args.command === "show") return await showLibraryItem(library, snapshot, libraryRoot, args.id);
    if (args.command === "validate") return { status: "valid", manifest: manifestPath, asset_count: snapshot.assets.length, set_count: snapshot.sets.length };
    const result = await library.applyPlan(await readPlan(args.plan), { dryRun: args.dryRun });
    return { status: result.status, manifest: manifestPath, operations: result.operations, asset_count: result.assetCount, set_count: result.setCount };
  } catch (error) {
    throw asManagerError(error);
  }
}

export async function runVisualReferenceManagerCli(values, { environment = process.env } = {}) {
  const args = parseVisualReferenceManagerArgs(values);
  const dataRoot = resolveSuzuLivesDataRoot({ configuredRoot: args.dataRoot || environment.SUZU_LIVES_DATA_ROOT, localAppData: environment.LOCALAPPDATA, fallbackBase: "" });
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: args.agentId || environment.SUZU_LIVES_AGENT_ID, projectRoot: args.projectRoot || environment.SUZU_LIVES_PROJECT_ROOT });
  return runVisualReferenceManager({ agentRoot, args });
}
