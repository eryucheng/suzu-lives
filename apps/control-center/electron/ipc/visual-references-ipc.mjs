import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { createVisualReferenceLibrary, inspectImage, suggestAssetId } from "@suzu-lives/visual-reference-library";

const SELECTION_TTL_MS = 10 * 60 * 1000;

function libraryFor(settingsService) {
  const settings = settingsService.load();
  const dataRoot = settingsService.response(settings).dataRoot;
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId || "unassigned" });
  return { settings, library: createVisualReferenceLibrary({ libraryRoot: path.join(agentRoot, "visual-references") }) };
}

export function registerVisualReferencesIpc({ dialog, getMainWindow, ipcMain, nativeImage, settingsService }) {
  const selections = new Map();
  const consumeSelection = (token) => {
    const selected = selections.get(String(token || ""));
    if (!selected || selected.expiresAt < Date.now()) {
      selections.delete(String(token || ""));
      throw new Error("所选图片已失效，请重新选择。");
    }
    return selected;
  };

  ipcMain.handle("visual-references:snapshot", async () => {
    const { library } = libraryFor(settingsService);
    return library.snapshot();
  });
  ipcMain.handle("visual-references:select-image", async (_event, assetRole) => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择视觉参考图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const image = await inspectImage(result.filePaths[0]);
    const token = randomUUID();
    selections.set(token, { source: image.source, expiresAt: Date.now() + SELECTION_TTL_MS });
    return { canceled: false, selectionToken: token, fileName: path.basename(image.source), candidateId: suggestAssetId(path.basename(image.source), assetRole) };
  });
  ipcMain.handle("visual-references:add", async (_event, value) => {
    const selection = consumeSelection(value?.selectionToken);
    const { library } = libraryFor(settingsService);
    const result = await library.add({ ...value, source: selection.source });
    selections.delete(String(value.selectionToken));
    return result;
  });
  ipcMain.handle("visual-references:update", (_event, value) => libraryFor(settingsService).library.update(value));
  ipcMain.handle("visual-references:upsert-set", (_event, value) => libraryFor(settingsService).library.upsertSet(value));
  ipcMain.handle("visual-references:remove-set", (_event, id) => libraryFor(settingsService).library.removeSet(id));
  ipcMain.handle("visual-references:remove", (_event, value) => {
    if (value?.confirmed !== true) throw new Error("移除资料前需要明确确认。");
    return libraryFor(settingsService).library.remove(value);
  });
  ipcMain.handle("visual-references:thumbnail", async (_event, id) => {
    const imagePath = await libraryFor(settingsService).library.assetPath(id);
    const image = nativeImage.createFromPath(imagePath);
    if (image.isEmpty()) throw new Error("无法读取该参考图缩略图。");
    return image.resize({ width: 420, height: 420, quality: "good" }).toDataURL();
  });
}
