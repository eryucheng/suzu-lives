import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { createCandidates, readCandidate, readRuns, validateComfyRegistry } from "@suzu-lives/image-workbench";
import { createVisualReferenceLibrary } from "@suzu-lives/visual-reference-library";

function existsDirectory(value) { try { return Boolean(value && fs.statSync(value).isDirectory()); } catch { return false; } }
function requireAgent(settings) { if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) throw new Error("请先选择有效的 Claude 项目，再创建绘画候选。"); }
function valuesFor(settingsService) { const settings = settingsService.load(); requireAgent(settings); const dataRoot = settingsService.response(settings).dataRoot; const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId }); return { settings, root: path.join(agentRoot, "image-workbench"), library: createVisualReferenceLibrary({ libraryRoot: path.join(agentRoot, "visual-references") }), ledgerPath: settingsService.usageLedgerPath(settings), dataRoot }; }
async function readJson(filePath, fallback) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; } }
async function comfySettings(dataRoot) { const value = await readJson(path.join(dataRoot, "connections", "comfyui.json"), {}); let registry = { version: 1, workflows: {} }; try { registry = validateComfyRegistry(value.registry || registry); } catch {} return { baseUrl: String(value.baseUrl || "http://127.0.0.1:8188").trim().replace(/\/+$/u, ""), timeoutMs: Number(value.timeoutMs) || 600000, pollIntervalMs: Number(value.pollIntervalMs) || 1000, registry }; }
async function snapshot(settingsService, connectionsService) { const settings = settingsService.load(); const api = await connectionsService.imageApiSnapshot(); const dataRoot = settingsService.response(settings).dataRoot; const comfyui = await comfySettings(dataRoot); if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) return { status: "needs-project", api, comfyui: { baseUrl: comfyui.baseUrl, workflows: Object.values(comfyui.registry.workflows).map(({ id, enabled, description }) => ({ id, enabled, description })) }, runs: [] }; const values = valuesFor(settingsService); return { status: "ready", api, comfyui: { baseUrl: comfyui.baseUrl, workflows: Object.values(comfyui.registry.workflows).map(({ id, enabled, description }) => ({ id, enabled, description })) }, runs: await readRuns(values.root) }; }
async function selectedReferences(library, ids) { const manifest = await library.snapshot(); if (!Array.isArray(ids) || ids.length > 12) throw new Error("参考图选择无效。"); const output = []; for (const id of ids) { const asset = manifest.assets.find((item) => item.id === String(id)); if (!asset) throw new Error("找不到所选视觉参考：" + id); const filePath = await library.assetPath(asset.id); output.push({ id: asset.id, role: asset.role, description: asset.description, filename: path.basename(filePath), mime: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(filePath).toLowerCase()] || "image/png", data: await fsp.readFile(filePath) }); } return output; }
export function imageUsageEvent(values, api, item) { return { agentId: values.settings.agentId, provider: item.input.backend === "comfyui" ? "本地 ComfyUI" : (api.provider || "OpenAI Compatible"), model: item.result.model, source: "图片生成", feature: item.input.backend === "comfyui" ? "image-workflow" : "image-" + item.result.mode, requestId: item.result.requestId, usage: item.result.usage, units: { imageRequests: 1, generatedImages: 1 }, metadata: { costSource: item.input.backend === "comfyui" ? "local-unpriced" : "provider-reported", size: item.input.size, referenceCount: item.referenceCount, backend: item.input.backend, workflow: item.result.workflow || "" } }; }

export function registerImageWorkbenchIpc({ ipcMain, nativeImage, settingsService, connectionsService }) {
  ipcMain.handle("image-workbench:snapshot", () => snapshot(settingsService, connectionsService));
  ipcMain.handle("image-workbench:generate", async (_event, input) => {
    const values = valuesFor(settingsService); const api = await connectionsService.resolveImageApi(); const comfyui = await comfySettings(values.dataRoot); const references = await selectedReferences(values.library, input?.referenceIds || []);
    await createCandidates({ root: values.root, connection: input?.backend === "api" ? api : comfyui, registry: comfyui.registry, input, references, onSuccess: async (item) => appendUsageEvent(values.ledgerPath, imageUsageEvent(values, api, item)) });
    return snapshot(settingsService, connectionsService);
  });
  ipcMain.handle("image-workbench:thumbnail", async (_event, runId, candidateId) => { const values = valuesFor(settingsService); const image = nativeImage.createFromBuffer(await readCandidate(values.root, runId, candidateId)); if (image.isEmpty()) throw new Error("无法读取候选图片。"); return image.resize({ width: 600, height: 600, quality: "good" }).toDataURL(); });
}
