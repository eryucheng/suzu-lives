import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ROLES = Object.freeze(["identity", "location", "object", "style"]);
export const ROLE_DIRECTORIES = Object.freeze({ identity: "characters", location: "places", object: "objects", style: "styles" });
export const SUPPORTED_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".webp"]);
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export class VisualReferenceError extends Error {}

function clean(value) { return String(value ?? "").trim(); }
function emptyManifest() { return { version: 1, assets: {}, sets: {} }; }
function role(value) { const result = clean(value); if (!ROLES.includes(result)) throw new VisualReferenceError("角色必须是有效的 identity、location、object 或 style。"); return result; }
export function validateId(value, label = "ID") { const id = clean(value); if (!ID_PATTERN.test(id) || id.length > 120) throw new VisualReferenceError(label + " 只能使用小写字母、数字、点和连字符。"); return id; }
function stringList(value, label) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new VisualReferenceError(label + " 必须是文本列表。"); return value.map((item, index) => { const text = clean(item); if (!text) throw new VisualReferenceError(label + " 的第 " + (index + 1) + " 项不能为空。"); return text.slice(0, 500); }); }
function text(value, label, { required = false, max = 2_000 } = {}) { const result = clean(value).slice(0, max); if (required && !result) throw new VisualReferenceError(label + " 不能为空。"); return result; }
function isWithin(root, target) { const relative = path.relative(root, target); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }

export function safeAssetPath(libraryRoot, relativePath) {
  const raw = clean(relativePath).replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || raw.split("/").includes("..")) throw new VisualReferenceError("参考图路径必须位于资料库内。");
  const root = path.resolve(libraryRoot);
  const target = path.resolve(root, ...raw.split("/"));
  if (!isWithin(root, target) || !SUPPORTED_EXTENSIONS.includes(path.extname(target).toLowerCase())) throw new VisualReferenceError("参考图路径无效或越出资料库。");
  return target;
}

export function relativeAssetPath(id, assetRole, extension) {
  const safeId = validateId(id, "资料 ID");
  const safeRole = role(assetRole);
  const suffix = clean(extension).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(suffix)) throw new VisualReferenceError("仅支持 PNG、JPG、JPEG 或 WebP 图片。");
  const parts = safeId.split(".");
  return path.posix.join(ROLE_DIRECTORIES[safeRole], ...parts.slice(0, -1), parts.at(-1) + suffix);
}

export function suggestAssetId(fileName, assetRole) {
  const prefix = { identity: "character", location: "place", object: "object", style: "style" }[role(assetRole)];
  const base = path.basename(clean(fileName), path.extname(clean(fileName))).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, ".").replace(/^\.+|\.+$/gu, "").replace(/\.{2,}/gu, ".");
  return validateId(prefix + "." + (base || "reference"), "候选 ID");
}

export async function inspectImage(filePath) {
  const source = path.resolve(clean(filePath));
  const extension = path.extname(source).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new VisualReferenceError("仅支持 PNG、JPG、JPEG 或 WebP 图片。");
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size < 12 || stat.size > MAX_IMAGE_BYTES) throw new VisualReferenceError("图片必须是小于 50MB 的普通文件。");
  const header = (await fs.readFile(source)).subarray(0, 16);
  const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const webp = header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
  const matchesExtension = (png && extension === ".png") || (jpeg && (extension === ".jpg" || extension === ".jpeg")) || (webp && extension === ".webp");
  if (!matchesExtension) throw new VisualReferenceError("文件扩展名与图片内容不匹配。");
  return { source, extension, size: stat.size };
}

async function pathExists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
async function readJson(filePath) { try { return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "")); } catch (error) { throw new VisualReferenceError("无法读取资料库清单：" + (error instanceof SyntaxError ? "JSON 格式错误。" : "文件不可读取。")); } }

async function validateManifest(value, libraryRoot, { requireFiles = true, allowedMissing = new Set() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !value.assets || typeof value.assets !== "object" || Array.isArray(value.assets) || !value.sets || typeof value.sets !== "object" || Array.isArray(value.sets)) throw new VisualReferenceError("资料库清单必须是 version 1，且包含 assets 与 sets。");
  const assets = {};
  const usedPaths = new Set();
  for (const [rawId, valueAsset] of Object.entries(value.assets)) {
    const id = validateId(rawId, "资料 ID");
    if (!valueAsset || typeof valueAsset !== "object" || Array.isArray(valueAsset)) throw new VisualReferenceError("资料 " + id + " 无效。");
    const assetRole = role(valueAsset.role);
    const relative = clean(valueAsset.path).replaceAll("\\", "/");
    const target = safeAssetPath(libraryRoot, relative);
    const pathKey = target.toLowerCase();
    if (usedPaths.has(pathKey)) throw new VisualReferenceError("同一图片不能被多个资料重复引用。");
    usedPaths.add(pathKey);
    if (requireFiles && !allowedMissing.has(relative)) await inspectImage(target);
    assets[id] = { path: relative, role: assetRole, description: text(valueAsset.description, "资料 " + id + " 的描述", { required: true }), preserve: stringList(valueAsset.preserve, "资料 " + id + " 的保留特征"), ignore: stringList(valueAsset.ignore, "资料 " + id + " 的忽略特征") };
  }
  const sets = {};
  for (const [rawId, valueSet] of Object.entries(value.sets)) {
    const id = validateId(rawId, "分组 ID");
    if (assets[id]) throw new VisualReferenceError("资料与分组不能使用相同 ID。");
    if (!valueSet || typeof valueSet !== "object" || Array.isArray(valueSet) || !Array.isArray(valueSet.assets)) throw new VisualReferenceError("分组 " + id + " 无效。");
    const members = [...new Set(valueSet.assets.map((member) => validateId(member, "分组 " + id + " 成员")))];
    if (members.some((member) => !assets[member])) throw new VisualReferenceError("分组 " + id + " 包含不存在的资料。");
    sets[id] = { description: text(valueSet.description, "分组 " + id + " 的描述", { required: true }), assets: members };
  }
  return { version: 1, assets, sets };
}

async function readManifest(libraryRoot) {
  const manifestPath = path.join(libraryRoot, "manifest.json");
  if (!(await pathExists(manifestPath))) return emptyManifest();
  return validateManifest(await readJson(manifestPath), libraryRoot);
}

export async function writeManifestAtomic(libraryRoot, manifest) {
  await fs.mkdir(libraryRoot, { recursive: true });
  const destination = path.join(libraryRoot, "manifest.json");
  const temporary = path.join(libraryRoot, ".manifest-" + randomUUID() + ".tmp");
  const handle = await fs.open(temporary, "w");
  try { await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, destination);
}

function setMembership(manifest, id, setIds) {
  for (const setId of setIds) if (!manifest.sets[setId]) throw new VisualReferenceError("分组不存在：" + setId);
  for (const value of Object.values(manifest.sets)) value.assets = value.assets.filter((member) => member !== id);
  for (const setId of setIds) manifest.sets[setId].assets.push(id);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function planSetDescriptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VisualReferenceError("维护计划的 sets 必须是对象。 ");
  const descriptions = {};
  for (const [rawId, rawDescription] of Object.entries(value)) {
    const id = validateId(rawId, "计划分组 ID");
    descriptions[id] = text(rawDescription, "计划分组 " + id + " 的描述", { required: true });
  }
  return descriptions;
}

function planMembership(value, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new VisualReferenceError(label + " 必须是文本列表。 ");
  return [...new Set(value.map((item) => validateId(item, label)))];
}

function ensurePlanSet(manifest, id, descriptions) {
  if (manifest.assets[id]) throw new VisualReferenceError("分组 ID 与资料 ID 不能相同：" + id);
  if (!manifest.sets[id]) {
    const description = descriptions[id];
    if (!description) throw new VisualReferenceError("新增分组必须在计划 sets 中填写描述：" + id);
    manifest.sets[id] = { description, assets: [] };
  } else if (descriptions[id]) {
    manifest.sets[id].description = descriptions[id];
  }
}

async function planTransaction(libraryRoot, plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.version !== 1) {
    throw new VisualReferenceError("维护计划必须是 version 1。 ");
  }
  if (!Array.isArray(plan.operations) || !plan.operations.length) {
    throw new VisualReferenceError("维护计划的 operations 必须是非空数组。 ");
  }
  const descriptions = planSetDescriptions(plan.sets ?? {});
  const next = clone(await readManifest(libraryRoot));
  const copies = [];
  const deletions = [];
  const summary = [];
  const seen = new Set();

  for (const [index, raw] of plan.operations.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VisualReferenceError(`operations[${index}] 必须是对象。`);
    const action = clean(raw.action);
    const id = validateId(raw.id, `operations[${index}].id`);
    if (seen.has(id)) throw new VisualReferenceError("同一计划不能多次操作同一资料：" + id);
    seen.add(id);

    if (action === "add") {
      if (next.assets[id]) throw new VisualReferenceError("资料 ID 已存在，不能静默覆盖：" + id);
      const assetRole = role(raw.role);
      const source = path.resolve(clean(raw.source));
      let image;
      try { image = await inspectImage(source); } catch (error) {
        if (error instanceof VisualReferenceError) throw error;
        throw new VisualReferenceError("源图片不存在或不可读取：" + source);
      }
      const relative = relativeAssetPath(id, assetRole, image.extension);
      const target = safeAssetPath(libraryRoot, relative);
      if (await pathExists(target)) throw new VisualReferenceError("目标图片已存在，不能静默覆盖：" + relative);
      const memberships = planMembership(raw.sets ?? [], `operations[${index}].sets`) || [];
      for (const setId of memberships) ensurePlanSet(next, setId, descriptions);
      next.assets[id] = {
        path: relative,
        role: assetRole,
        description: text(raw.description, `operations[${index}].description`, { required: true }),
        preserve: stringList(raw.preserve, `operations[${index}].preserve`),
        ignore: stringList(raw.ignore, `operations[${index}].ignore`),
      };
      setMembership(next, id, memberships);
      copies.push({ source: image.source, target, relative });
      summary.push({ action, id, path: relative, sets: memberships });
      continue;
    }

    if (action === "update") {
      const current = next.assets[id];
      if (!current) throw new VisualReferenceError("找不到要更新的资料：" + id);
      const memberships = planMembership(raw.sets, `operations[${index}].sets`);
      if (raw.description !== undefined) current.description = text(raw.description, `operations[${index}].description`, { required: true });
      if (raw.preserve !== undefined) current.preserve = stringList(raw.preserve, `operations[${index}].preserve`);
      if (raw.ignore !== undefined) current.ignore = stringList(raw.ignore, `operations[${index}].ignore`);
      if (raw.role !== undefined) {
        const nextRole = role(raw.role);
        if (nextRole !== current.role) {
          const source = safeAssetPath(libraryRoot, current.path);
          const relative = relativeAssetPath(id, nextRole, path.extname(source));
          const target = safeAssetPath(libraryRoot, relative);
          if (await pathExists(target)) throw new VisualReferenceError("修改角色后的目标图片已存在，不能静默覆盖：" + relative);
          current.role = nextRole;
          current.path = relative;
          copies.push({ source, target, relative });
          deletions.push(source);
        }
      }
      if (memberships !== null) {
        for (const setId of memberships) ensurePlanSet(next, setId, descriptions);
        setMembership(next, id, memberships);
      }
      summary.push({ action, id, role: current.role, path: current.path, sets: memberships });
      continue;
    }

    if (action === "remove") {
      const current = next.assets[id];
      if (!current) throw new VisualReferenceError("找不到要移除的资料：" + id);
      if (typeof raw.delete_file !== "boolean") throw new VisualReferenceError(`operations[${index}].delete_file 必须明确填写 true 或 false。`);
      delete next.assets[id];
      for (const value of Object.values(next.sets)) value.assets = value.assets.filter((member) => member !== id);
      if (raw.delete_file) deletions.push(safeAssetPath(libraryRoot, current.path));
      summary.push({ action, id, deleted_file: raw.delete_file });
      continue;
    }

    throw new VisualReferenceError(`operations[${index}].action 只能是 add、update 或 remove。`);
  }

  for (const [id, description] of Object.entries(descriptions)) {
    if (next.sets[id]) next.sets[id].description = description;
  }
  const normalized = await validateManifest(next, libraryRoot, { allowedMissing: new Set(copies.map((item) => item.relative)) });
  return { manifest: normalized, copies, deletions, summary };
}

async function commit(libraryRoot, manifest, { copies = [], deletions = [] } = {}) {
  const normalized = await validateManifest(manifest, libraryRoot, { allowedMissing: new Set(copies.map((copy) => copy.relative)) });
  await fs.mkdir(libraryRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(libraryRoot, ".reference-stage-"));
  const movedCopies = [];
  const movedDeletions = [];
  try {
    const staged = [];
    for (const [index, copy] of copies.entries()) {
      await inspectImage(copy.source);
      const stagePath = path.join(stage, "add-" + index + path.extname(copy.source).toLowerCase());
      await fs.copyFile(copy.source, stagePath, fs.constants.COPYFILE_EXCL);
      staged.push({ stagePath, target: copy.target });
    }
    for (const [index, target] of deletions.entries()) {
      if (!(await pathExists(target))) continue;
      const backup = path.join(stage, "remove-" + index + path.extname(target).toLowerCase());
      await fs.rename(target, backup);
      movedDeletions.push({ backup, target });
    }
    for (const item of staged) {
      if (await pathExists(item.target)) throw new VisualReferenceError("目标图片已存在，不能静默覆盖。");
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      await fs.rename(item.stagePath, item.target);
      movedCopies.push(item.target);
    }
    await writeManifestAtomic(libraryRoot, normalized);
    return normalized;
  } catch (error) {
    for (const target of movedCopies.reverse()) await fs.rm(target, { force: true }).catch(() => {});
    for (const item of movedDeletions.reverse()) { await fs.mkdir(path.dirname(item.target), { recursive: true }); if (await pathExists(item.backup)) await fs.rename(item.backup, item.target).catch(() => {}); }
    throw error;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

function snapshot(manifest) {
  const assetSets = new Map(Object.keys(manifest.assets).map((id) => [id, []]));
  for (const [id, value] of Object.entries(manifest.sets)) for (const assetId of value.assets) assetSets.get(assetId)?.push(id);
  return {
    status: Object.keys(manifest.assets).length ? "ready" : "empty",
    assets: Object.entries(manifest.assets).map(([id, value]) => ({ id, role: value.role, description: value.description, preserve: value.preserve, ignore: value.ignore, sets: assetSets.get(id) || [] })),
    sets: Object.entries(manifest.sets).map(([id, value]) => ({ id, description: value.description, assets: value.assets })),
  };
}

export function createVisualReferenceLibrary({ libraryRoot }) {
  const root = path.resolve(clean(libraryRoot));
  if (!root) throw new VisualReferenceError("缺少资料库根目录。");
  const manifestPath = () => path.join(root, "manifest.json");
  return {
    root,
    async snapshot() { try { return snapshot(await readManifest(root)); } catch (error) { return { status: "invalid", assets: [], sets: [], message: error.message }; } },
    async assetPath(id) { const manifest = await readManifest(root); const asset = manifest.assets[validateId(id, "资料 ID")]; if (!asset) throw new VisualReferenceError("找不到该资料。"); return safeAssetPath(root, asset.path); },
    async add({ source, id, role: assetRole, description, preserve, ignore, sets = [] } = {}) {
      const manifest = await readManifest(root);
      const assetId = validateId(id, "资料 ID");
      if (manifest.assets[assetId]) throw new VisualReferenceError("资料 ID 已存在，不能静默覆盖。");
      const image = await inspectImage(source);
      const normalizedRole = role(assetRole);
      const relative = relativeAssetPath(assetId, normalizedRole, image.extension);
      const target = safeAssetPath(root, relative);
      if (await pathExists(target)) throw new VisualReferenceError("目标图片已存在，不能静默覆盖。");
      const next = clone(manifest);
      next.assets[assetId] = { path: relative, role: normalizedRole, description: text(description, "描述", { required: true }), preserve: stringList(preserve, "保留特征"), ignore: stringList(ignore, "忽略特征") };
      setMembership(next, assetId, [...new Set((sets || []).map((item) => validateId(item, "分组 ID")))]);
      await commit(root, next, { copies: [{ source: image.source, target, relative }] });
      return snapshot(await readManifest(root));
    },
    async update({ id, role: nextRole, description, preserve, ignore, sets } = {}) {
      const manifest = await readManifest(root);
      const assetId = validateId(id, "资料 ID");
      const current = manifest.assets[assetId];
      if (!current) throw new VisualReferenceError("找不到要编辑的资料。");
      const next = clone(manifest);
      const asset = next.assets[assetId];
      const normalizedRole = nextRole === undefined ? asset.role : role(nextRole);
      asset.description = description === undefined ? asset.description : text(description, "描述", { required: true });
      asset.preserve = preserve === undefined ? asset.preserve : stringList(preserve, "保留特征");
      asset.ignore = ignore === undefined ? asset.ignore : stringList(ignore, "忽略特征");
      asset.role = normalizedRole;
      const copies = [];
      const deletions = [];
      if (normalizedRole !== current.role) {
        const source = safeAssetPath(root, current.path);
        const relative = relativeAssetPath(assetId, normalizedRole, path.extname(source));
        const target = safeAssetPath(root, relative);
        if (await pathExists(target)) throw new VisualReferenceError("修改角色后的目标图片已存在，不能静默覆盖。");
        asset.path = relative;
        copies.push({ source, target, relative });
        deletions.push(source);
      }
      if (sets !== undefined) setMembership(next, assetId, [...new Set(sets.map((item) => validateId(item, "分组 ID")))]);
      await commit(root, next, { copies, deletions });
      return snapshot(await readManifest(root));
    },
    async upsertSet({ id, description } = {}) {
      const manifest = await readManifest(root);
      const setId = validateId(id, "分组 ID");
      if (manifest.assets[setId]) throw new VisualReferenceError("资料与分组不能使用相同 ID。");
      const next = clone(manifest);
      next.sets[setId] = { description: text(description, "分组描述", { required: true }), assets: next.sets[setId]?.assets || [] };
      await commit(root, next);
      return snapshot(await readManifest(root));
    },
    async removeSet(id) {
      const manifest = await readManifest(root);
      const setId = validateId(id, "分组 ID");
      if (!manifest.sets[setId]) throw new VisualReferenceError("找不到要移除的分组。");
      const next = clone(manifest);
      delete next.sets[setId];
      await commit(root, next);
      return snapshot(await readManifest(root));
    },
    async remove({ id, deleteFile } = {}) {
      if (typeof deleteFile !== "boolean") throw new VisualReferenceError("移除时必须明确选择是否同时删除软件内副本。");
      const manifest = await readManifest(root);
      const assetId = validateId(id, "资料 ID");
      const asset = manifest.assets[assetId];
      if (!asset) throw new VisualReferenceError("找不到要移除的资料。");
      const next = clone(manifest);
      delete next.assets[assetId];
      for (const value of Object.values(next.sets)) value.assets = value.assets.filter((member) => member !== assetId);
      await commit(root, next, { deletions: deleteFile ? [safeAssetPath(root, asset.path)] : [] });
      return snapshot(await readManifest(root));
    },
    async applyPlan(plan, { dryRun = false } = {}) {
      const transaction = await planTransaction(root, plan);
      const result = {
        status: dryRun ? "dry-run" : "written",
        operations: transaction.summary,
        assetCount: Object.keys(transaction.manifest.assets).length,
        setCount: Object.keys(transaction.manifest.sets).length,
      };
      if (!dryRun) await commit(root, transaction.manifest, { copies: transaction.copies, deletions: transaction.deletions });
      return result;
    },
    manifestPath,
  };
}
