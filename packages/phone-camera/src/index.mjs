import fs from "node:fs/promises";
import path from "node:path";

import { createCandidates } from "@suzu-lives/image-workbench";
import {
  createVisualReferenceLibrary,
  resolveAgentVisualReferenceLibraryRoot,
  resolveSharedVisualReferenceLibraryRoot,
  VisualReferenceError,
} from "@suzu-lives/visual-reference-library";

import profiles from "../profiles.json" with { type: "json" };

export class PhoneCameraError extends Error {}
export const MAX_REFERENCES = 16;
const SHOTS = new Set(["rear", "selfie", "mirror"]);
const REFERENCE_SCOPES = new Set(["shared", "contact"]);

function clean(value) { return String(value ?? "").trim(); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function rooted(root, value, label) { const base = path.resolve(root); const raw = clean(value); const target = path.resolve(base, raw || "."); if (!inside(base, target)) throw new PhoneCameraError(label + "必须位于当前 Agent 的 Suzu Lives 数据目录。 "); return target; }
function imageGenerationConfigRoot(dataRoot) { const root = clean(dataRoot); if (!root) throw new PhoneCameraError("缺少 Suzu Lives 软件数据目录。 "); return path.join(path.resolve(root), "capabilities", "image-generation"); }
function imageGenerationConfigPath({ dataRoot } = {}) { return path.join(imageGenerationConfigRoot(dataRoot), "config.json"); }
function list(value) { return Array.isArray(value) ? value : []; }
function phoneCameraStyle(value) {
  const source = object(value);
  return object(source.phone_camera ?? source.phoneCamera);
}

export function normalizePhoneConfig(value = {}) {
  const source = object(value); const references = object(source.references); const output = object(source.output); const prompt = object(source.prompt); const sizes = object(source.size_by_shot);
  const maxImages = Number(references.max_images ?? 8);
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > MAX_REFERENCES) throw new PhoneCameraError(`references.max_images 必须在 1 到 ${MAX_REFERENCES} 之间。`);
  return { sizeByShot: { rear: clean(sizes.rear) || clean(profiles.shots.rear.default_size), selfie: clean(sizes.selfie) || clean(profiles.shots.selfie.default_size), mirror: clean(sizes.mirror) || clean(profiles.shots.mirror.default_size) }, references: { maxImages }, output: { directory: clean(output.directory) || "image-generation/phone-camera" }, prompt: { prefix: clean(prompt.prefix), suffix: clean(prompt.suffix) } };
}

export async function loadPhoneCameraStyleConfig({ dataRoot } = {}) {
  const target = imageGenerationConfigPath({ dataRoot });
  try {
    const value = JSON.parse(await fs.readFile(target, "utf8"));
    return { config: normalizePhoneConfig(phoneCameraStyle(value)), path: target, source: "saved" };
  } catch (error) {
    if (error?.code === "ENOENT") return { config: normalizePhoneConfig(), path: target, source: "default" };
    if (error instanceof SyntaxError) throw new PhoneCameraError("图像生成配置必须是 JSON 对象。 ");
    throw error;
  }
}

function referencePrompt(references) {
  if (!references.length) return "";
  const blocks = references.map((item, index) => { const lines = [`Image ${index + 1}`, `ID: ${item.id}`, `Role: ${item.role} reference`, `Description: ${item.description}`]; if (item.preserve.length) lines.push(`Preserve: ${item.preserve.join("; ")}`); if (item.ignore.length) lines.push(`Do not inherit: ${item.ignore.join("; ")}`); return lines.join("\n"); });
  return "Reference images are ordered exactly as uploaded. Use each image only for its stated role.\n\n" + blocks.join("\n\n");
}

export function buildPhonePrompt({ scene, shot, config, references = [] } = {}) {
  const visibleScene = clean(scene); if (!visibleScene) throw new PhoneCameraError("--scene 不能为空。 "); if (visibleScene.length > 5000) throw new PhoneCameraError("--scene 过长，请只写画面中真正可见的内容。 "); if (!SHOTS.has(shot)) throw new PhoneCameraError("--shot 必须是 rear、selfie 或 mirror。 ");
  const values = normalizePhoneConfig(config); const profile = profiles.shots[shot];
  const parts = [["Goal", profiles.shared.goal], ["Visible scene", visibleScene], ["Reference image roles", referencePrompt(references)], ["Shot and framing", profile.shot], ["Camera geometry", profile.geometry], ["Natural phone-camera look", [profiles.shared.look, profile.look].filter(Boolean).join(" ")], ["Hard constraints", [profiles.shared.constraints, profile.constraints].filter(Boolean).join(" ")]].filter(([, text]) => clean(text)).map(([name, text]) => `${name}:\n${text}`);
  return [values.prompt.prefix, parts.join("\n\n"), values.prompt.suffix].filter(Boolean).join("\n\n");
}

function referenceRequest(value) {
  if (typeof value === "string") {
    const raw = clean(value);
    const separator = raw.indexOf(":");
    if (separator < 0) return { scope: "", id: raw };
    return { scope: raw.slice(0, separator), id: raw.slice(separator + 1) };
  }
  const source = object(value);
  return { scope: clean(source.scope), id: clean(source.id) };
}

function validateReferenceRequest(value) {
  const reference = referenceRequest(value);
  if (!REFERENCE_SCOPES.has(reference.scope) || !reference.id) {
    throw new PhoneCameraError("视觉参考必须明确包含 shared 或 contact 归属及资料 ID。 ");
  }
  return reference;
}

export async function expandReferences({ agentRoot, dataRoot = "", requested = [], maxImages = 8 } = {}) {
  if (!requested.length) return [];
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > MAX_REFERENCES) throw new PhoneCameraError(`references.max_images 必须在 1 到 ${MAX_REFERENCES} 之间。`);
  const root = path.resolve(clean(agentRoot));
  if (!clean(agentRoot)) throw new PhoneCameraError("缺少当前联系人资料目录。 ");
  const libraries = {
    contact: createVisualReferenceLibrary({ libraryRoot: resolveAgentVisualReferenceLibraryRoot(root) }),
    ...(clean(dataRoot) ? { shared: createVisualReferenceLibrary({ libraryRoot: resolveSharedVisualReferenceLibraryRoot(dataRoot) }) } : {}),
  };
  const snapshots = new Map();
  const getSnapshot = async (scope) => {
    const library = libraries[scope];
    if (!library) throw new PhoneCameraError("共享视觉参考需要 Suzu Lives 软件数据目录。 ");
    if (!snapshots.has(scope)) snapshots.set(scope, await library.snapshot());
    const snapshot = snapshots.get(scope);
    if (snapshot.status === "invalid") throw new PhoneCameraError(snapshot.message || "视觉参考库无效。 ");
    return { library, snapshot };
  };
  const selected = [];
  const seen = new Set();
  for (const raw of requested) {
    const reference = validateReferenceRequest(raw);
    const { snapshot } = await getSnapshot(reference.scope);
    const assets = new Map(snapshot.assets.map((item) => [item.id, item]));
    const sets = new Map(snapshot.sets.map((item) => [item.id, item]));
    const candidates = assets.has(reference.id) ? [reference.id] : sets.get(reference.id)?.assets;
    if (!candidates) throw new PhoneCameraError("找不到参考 asset 或 set：" + reference.scope + ":" + reference.id);
    for (const id of candidates) {
      const key = reference.scope + ":" + id;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push({ scope: reference.scope, id });
    }
  }
  if (selected.length > maxImages) throw new PhoneCameraError(`本次展开出 ${selected.length} 张参考图，超过配置上限 ${maxImages}；请只选择当前场景需要的参考组。`);
  try { return await Promise.all(selected.map(async (reference, index) => { const { library, snapshot } = await getSnapshot(reference.scope); const item = snapshot.assets.find((asset) => asset.id === reference.id); const filePath = await library.assetPath(reference.id); const relativeRoot = reference.scope === "shared" ? path.resolve(dataRoot) : root; return { index: index + 1, id: reference.scope + ":" + reference.id, role: item.role, path: path.relative(relativeRoot, filePath).split(path.sep).join("/"), description: item.description, preserve: list(item.preserve), ignore: list(item.ignore), filename: path.basename(filePath), mime: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(filePath).toLowerCase()] || "image/png", data: await fs.readFile(filePath) }; })); }
  catch (error) { if (error instanceof VisualReferenceError) throw new PhoneCameraError(error.message); throw error; }
}

export async function takePhonePhoto({ agentRoot, dataRoot, connection, fetchImpl, options = {} } = {}) {
  const root = path.resolve(clean(agentRoot)); if (!clean(agentRoot)) throw new PhoneCameraError("缺少当前 Agent 数据目录。 ");
  const loaded = options.styleConfig === undefined
    ? await loadPhoneCameraStyleConfig({ dataRoot })
    : { config: normalizePhoneConfig(options.styleConfig), source: "provided" };
  const { config, source: configSource } = loaded;
  const shot = clean(options.shot); const scene = clean(options.scene); const backend = "api"; if (!SHOTS.has(shot)) throw new PhoneCameraError("--shot 必须是 rear、selfie 或 mirror。 ");
  const references = await expandReferences({ agentRoot: root, dataRoot, requested: list(options.refs), maxImages: config.references.maxImages }); const prompt = buildPhonePrompt({ scene, shot, config, references }); const size = clean(options.size) || config.sizeByShot[shot];
  if (options.dryRun) return { status: "dry-run", backend, shot, size, references: references.map(({ index, id, role, path: referencePath }) => ({ index, id, role, path: referencePath })), prompt, configSource };
  const outputRoot = rooted(root, clean(options.out) || config.output.directory, "--out");
  const result = await createCandidates({ root: outputRoot, connection, input: { prompt, backend, count: 1, size, includeReferencePrompt: false }, references, maxReferences: MAX_REFERENCES, fetchImpl });
  const candidate = result.candidates[0]; const outputPath = path.join(outputRoot, candidate.file);
  return { status: "ok", backend, path: outputPath, sent: false, shot, references: references.map((item) => item.id), model: candidate.model, requestId: candidate.requestId || "" };
}
