import fs from "node:fs/promises";
import path from "node:path";

import { createCandidates } from "@suzu-lives/image-workbench";
import { createVisualReferenceLibrary, VisualReferenceError } from "@suzu-lives/visual-reference-library";

import profiles from "../profiles.json" with { type: "json" };

export class PhoneCameraError extends Error {}
export const MAX_REFERENCES = 16;
const SHOTS = new Set(["rear", "selfie", "mirror"]);

function clean(value) { return String(value ?? "").trim(); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function rooted(root, value, label) { const base = path.resolve(root); const raw = clean(value); const target = path.resolve(base, raw || "."); if (!inside(base, target)) throw new PhoneCameraError(label + "必须位于当前 Agent 的 Suzu Lives 数据目录。 "); return target; }
function list(value) { return Array.isArray(value) ? value : []; }

export function normalizePhoneConfig(value = {}) {
  const source = object(value); const references = object(source.references); const output = object(source.output); const prompt = object(source.prompt); const sizes = object(source.size_by_shot);
  const maxImages = Number(references.max_images ?? 8);
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > MAX_REFERENCES) throw new PhoneCameraError(`references.max_images 必须在 1 到 ${MAX_REFERENCES} 之间。`);
  return { sizeByShot: { rear: clean(sizes.rear) || clean(profiles.shots.rear.default_size), selfie: clean(sizes.selfie) || clean(profiles.shots.selfie.default_size), mirror: clean(sizes.mirror) || clean(profiles.shots.mirror.default_size) }, references: { manifest: clean(references.manifest) || "visual-references/manifest.json", maxImages }, output: { directory: clean(output.directory) || "phone-camera" }, prompt: { prefix: clean(prompt.prefix), suffix: clean(prompt.suffix) }, defaultBackend: clean(source.default_backend) || "api" };
}

export async function loadPhoneConfig(agentRoot, configPath = "") {
  const root = path.resolve(agentRoot); const target = configPath ? rooted(root, configPath, "--config") : path.join(root, "phone-camera", "config.json");
  try { return { config: normalizePhoneConfig(JSON.parse(await fs.readFile(target, "utf8"))), path: target, source: "saved" }; }
  catch (error) { if (error?.code === "ENOENT") return { config: normalizePhoneConfig(), path: target, source: "default" }; if (error instanceof SyntaxError) throw new PhoneCameraError("--config 必须是 JSON 对象。 "); throw error; }
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

export async function expandReferences({ agentRoot, manifest = "", requested = [], maxImages = 8 } = {}) {
  if (!requested.length) return [];
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > MAX_REFERENCES) throw new PhoneCameraError(`references.max_images 必须在 1 到 ${MAX_REFERENCES} 之间。`);
  const manifestPath = rooted(agentRoot, manifest || "visual-references/manifest.json", "--manifest"); if (path.basename(manifestPath) !== "manifest.json") throw new PhoneCameraError("--manifest 必须指向软件资料库的 manifest.json。 ");
  const library = createVisualReferenceLibrary({ libraryRoot: path.dirname(manifestPath) }); const snapshot = await library.snapshot(); if (snapshot.status === "invalid") throw new PhoneCameraError(snapshot.message || "视觉参考库无效。 ");
  const assets = new Map(snapshot.assets.map((item) => [item.id, item])); const sets = new Map(snapshot.sets.map((item) => [item.id, item])); const selected = []; const seen = new Set();
  for (const raw of requested) { const id = clean(raw); const candidates = assets.has(id) ? [id] : sets.get(id)?.assets; if (!candidates) throw new PhoneCameraError("找不到参考 asset 或 set：" + id); for (const candidate of candidates) if (!seen.has(candidate)) { seen.add(candidate); selected.push(candidate); } }
  if (selected.length > maxImages) throw new PhoneCameraError(`本次展开出 ${selected.length} 张参考图，超过配置上限 ${maxImages}；请只选择当前场景需要的参考组。`);
  try { return await Promise.all(selected.map(async (id, index) => { const item = assets.get(id); const filePath = await library.assetPath(id); return { index: index + 1, id, role: item.role, path: path.relative(path.resolve(agentRoot), filePath).split(path.sep).join("/"), description: item.description, preserve: list(item.preserve), ignore: list(item.ignore), filename: path.basename(filePath), mime: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(filePath).toLowerCase()] || "image/png", data: await fs.readFile(filePath) }; })); }
  catch (error) { if (error instanceof VisualReferenceError) throw new PhoneCameraError(error.message); throw error; }
}

export async function takePhonePhoto({ agentRoot, connection, registry, fetchImpl, options = {} } = {}) {
  const root = path.resolve(clean(agentRoot)); if (!clean(agentRoot)) throw new PhoneCameraError("缺少当前 Agent 数据目录。 ");
  const { config, path: phoneConfigPath, source: configSource } = await loadPhoneConfig(root, options.config);
  const shot = clean(options.shot); const scene = clean(options.scene); const backend = clean(options.backend) || config.defaultBackend; if (!SHOTS.has(shot)) throw new PhoneCameraError("--shot 必须是 rear、selfie 或 mirror。 "); if (!['api', 'comfyui'].includes(backend)) throw new PhoneCameraError("--backend 必须是 api 或 comfyui。 ");
  const manifest = clean(options.manifest) || config.references.manifest; const references = await expandReferences({ agentRoot: root, manifest, requested: list(options.refs), maxImages: config.references.maxImages }); const prompt = buildPhonePrompt({ scene, shot, config, references }); const size = clean(options.size) || config.sizeByShot[shot];
  if (options.dryRun) return { status: "dry-run", backend, workflow: clean(options.workflow) || null, shot, size, references: references.map(({ index, id, role, path: referencePath }) => ({ index, id, role, path: referencePath })), prompt, configSource };
  const outputRoot = rooted(root, clean(options.out) || config.output.directory, "--out");
  const result = await createCandidates({ root: outputRoot, connection, registry, input: { prompt, backend, workflow: clean(options.workflow), count: 1, size, seed: Number.isInteger(options.seed) ? options.seed : null, includeReferencePrompt: false }, references, maxReferences: MAX_REFERENCES, fetchImpl });
  const candidate = result.candidates[0]; const outputPath = path.join(outputRoot, candidate.file);
  return { status: "ok", backend, path: outputPath, sent: false, shot, references: references.map((item) => item.id), model: candidate.model, requestId: candidate.requestId || "", seed: candidate.seed, workflow: candidate.workflow || "" };
}
