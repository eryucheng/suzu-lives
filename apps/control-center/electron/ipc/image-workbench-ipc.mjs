import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { createCandidates, readCandidate, readRuns, validateComfyRegistry } from "@suzu-lives/image-workbench";
import {
  createVisualReferenceLibrary,
  resolveAgentVisualReferenceLibraryRoot,
  resolveSharedVisualReferenceLibraryRoot,
} from "@suzu-lives/visual-reference-library";

function existsDirectory(value) { try { return Boolean(value && fs.statSync(value).isDirectory()); } catch { return false; } }
function requireAgent(settings) { if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) throw new Error("请先选择有效的 Suzu 联系人工作区，再创建绘画候选。"); }
function valuesFor(settingsService) {
  const settings = settingsService.load();
  requireAgent(settings);
  const dataRoot = settingsService.response(settings).dataRoot;
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId });
  return {
    settings,
    root: path.join(agentRoot, "image-workbench"),
    libraries: {
      shared: createVisualReferenceLibrary({ libraryRoot: resolveSharedVisualReferenceLibraryRoot(dataRoot) }),
      contact: createVisualReferenceLibrary({ libraryRoot: resolveAgentVisualReferenceLibraryRoot(agentRoot) }),
    },
    ledgerPath: settingsService.usageLedgerPath(settings),
    dataRoot,
  };
}
async function readJson(filePath, fallback) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; } }
async function comfySettings(dataRoot) { const value = await readJson(path.join(dataRoot, "connections", "comfyui.json"), {}); let registry = { version: 1, workflows: {} }; try { registry = validateComfyRegistry(value.registry || registry); } catch {} return { baseUrl: String(value.baseUrl || "http://127.0.0.1:8188").trim().replace(/\/+$/u, ""), timeoutMs: Number(value.timeoutMs) || 600000, pollIntervalMs: Number(value.pollIntervalMs) || 1000, registry }; }
async function snapshot(settingsService, connectionsService) { const settings = settingsService.load(); const api = await connectionsService.imageApiSnapshot(); const dataRoot = settingsService.response(settings).dataRoot; const comfyui = await comfySettings(dataRoot); if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) return { status: "needs-project", api, comfyui: { baseUrl: comfyui.baseUrl, workflows: Object.values(comfyui.registry.workflows).map(({ id, enabled, description }) => ({ id, enabled, description })) }, runs: [] }; const values = valuesFor(settingsService); return { status: "ready", api, comfyui: { baseUrl: comfyui.baseUrl, workflows: Object.values(comfyui.registry.workflows).map(({ id, enabled, description }) => ({ id, enabled, description })) }, runs: await readRuns(values.root) }; }
function selectedReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参考图必须明确包含资料归属和 ID。 ");
  const scope = String(value.scope || "").trim();
  const id = String(value.id || "").trim();
  if (!new Set(["shared", "contact"]).has(scope) || !id) throw new Error("参考图必须明确包含资料归属和 ID。 ");
  return { scope, id };
}
async function selectedReferences(libraries, values) {
  if (!Array.isArray(values) || values.length > 12) throw new Error("参考图选择无效。 ");
  const requested = values.map(selectedReference);
  const seen = new Set();
  for (const reference of requested) {
    const key = reference.scope + ":" + reference.id;
    if (seen.has(key)) throw new Error("同一视觉参考不能重复选择。 ");
    seen.add(key);
  }
  const snapshots = new Map(await Promise.all(Object.entries(libraries).map(async ([scope, library]) => [scope, await library.snapshot()])));
  const output = [];
  for (const reference of requested) {
    const library = libraries[reference.scope];
    const snapshot = snapshots.get(reference.scope);
    if (!library || snapshot?.status === "invalid") throw new Error(snapshot?.message || "视觉参考库暂时无法打开。 ");
    const asset = snapshot.assets.find((item) => item.id === reference.id);
    if (!asset) throw new Error("找不到所选视觉参考：" + reference.scope + ":" + reference.id);
    const filePath = await library.assetPath(asset.id);
    output.push({ id: reference.scope + ":" + asset.id, role: asset.role, description: asset.description, filename: path.basename(filePath), mime: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(filePath).toLowerCase()] || "image/png", data: await fsp.readFile(filePath) });
  }
  return output;
}
export function imageUsageEvent(values, api, item) { return { agentId: values.settings.agentId, provider: item.input.backend === "comfyui" ? "本地 ComfyUI" : (api.provider || "OpenAI Compatible"), model: item.result.model, source: "图片生成", feature: item.input.backend === "comfyui" ? "image-workflow" : "image-" + item.result.mode, requestId: item.result.requestId, usage: item.result.usage, units: { imageRequests: 1, generatedImages: 1 }, metadata: { costSource: item.input.backend === "comfyui" ? "local-unpriced" : "provider-reported", size: item.input.size, referenceCount: item.referenceCount, backend: item.input.backend, workflow: item.result.workflow || "" } }; }

export function registerImageWorkbenchIpc({
  ipcMain,
  nativeImage,
  settingsService,
  connectionsService,
  recordCapabilityUsage = null,
}) {
  ipcMain.handle("image-workbench:snapshot", () => snapshot(settingsService, connectionsService));
  ipcMain.handle("image-workbench:generate", async (_event, input) => {
    const values = valuesFor(settingsService); const api = await connectionsService.resolveImageApi(); const comfyui = await comfySettings(values.dataRoot); const references = await selectedReferences(values.libraries, input?.referenceIds || []);
    await createCandidates({
      root: values.root,
      connection: input?.backend === "api" ? api : comfyui,
      registry: comfyui.registry,
      input,
      references,
      onSuccess: async (item) => {
        const event = imageUsageEvent(values, api, item);
        if (typeof recordCapabilityUsage === "function") {
          await recordCapabilityUsage({
            capabilityId: "image-generation",
            ledgerPath: values.ledgerPath,
            event,
          });
          return;
        }
        await appendUsageEvent(values.ledgerPath, event);
      },
    });
    return snapshot(settingsService, connectionsService);
  });
  ipcMain.handle("image-workbench:thumbnail", async (_event, runId, candidateId) => { const values = valuesFor(settingsService); const image = nativeImage.createFromBuffer(await readCandidate(values.root, runId, candidateId)); if (image.isEmpty()) throw new Error("无法读取候选图片。"); return image.resize({ width: 600, height: 600, quality: "good" }).toDataURL(); });
}
