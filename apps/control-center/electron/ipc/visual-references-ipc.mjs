import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import {
  createVisualReferenceLibrary,
  inspectImage,
  resolveAgentVisualReferenceLibraryRoot,
  resolveSharedVisualReferenceLibraryRoot,
  suggestAssetId,
} from "@suzu-lives/visual-reference-library";

const SELECTION_TTL_MS = 10 * 60 * 1000;
const REFERENCE_SCOPES = new Set(["shared", "contact"]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function scopeLabel(scope, contact) {
  return scope === "shared" ? "我的共享资料" : `${clean(contact?.name) || "当前联系人"} 的专属资料`;
}

function referenceKey(scope, id, contactId = "") {
  return scope === "contact" ? `contact:${contactId}:${id}` : `shared:${id}`;
}

function referenceRequest(value) {
  const source = plainObject(value);
  const reference = plainObject(source.reference);
  const scope = clean(reference.scope || source.scope);
  if (!REFERENCE_SCOPES.has(scope)) throw new Error("请选择资料归属：我的共享资料或当前联系人专属资料。 ");
  const id = clean(reference.id || source.id);
  if (!id) throw new Error("缺少视觉参考资料 ID。 ");
  return { scope, id, contactId: clean(reference.contactId || source.contactId) };
}

async function activeContactFor(settings, contactProjectsService) {
  if (!clean(settings.agentId) || !clean(settings.projectRoot) || typeof contactProjectsService?.snapshot !== "function") return null;
  try {
    const snapshot = await contactProjectsService.snapshot();
    const contact = snapshot?.activeContact;
    return contact && clean(contact.agentId) === clean(settings.agentId) ? contact : null;
  } catch {
    return null;
  }
}

async function librariesFor(settingsService, contactProjectsService) {
  const settings = settingsService.load();
  const dataRoot = settingsService.response(settings).dataRoot;
  const contact = await activeContactFor(settings, contactProjectsService);
  const shared = createVisualReferenceLibrary({
    libraryRoot: resolveSharedVisualReferenceLibraryRoot(dataRoot),
  });
  const contactLibrary = contact
    ? createVisualReferenceLibrary({
      libraryRoot: resolveAgentVisualReferenceLibraryRoot(resolveAgentDataRoot({ dataRoot, agentId: contact.agentId })),
    })
    : null;
  return { contact, contactLibrary, shared };
}

function libraryForScope(context, request) {
  if (request.scope === "shared") return context.shared;
  if (!context.contact || !context.contactLibrary) throw new Error("请先选择联系人，才能使用联系人专属资料库。 ");
  if (request.contactId && request.contactId !== context.contact.id) {
    throw new Error("当前联系人已切换，请刷新后再操作专属资料。 ");
  }
  return context.contactLibrary;
}

function mergeScopeSnapshot(scope, source, contact) {
  const label = scopeLabel(scope, contact);
  const reference = (id) => ({ scope, id, ...(scope === "contact" ? { contactId: contact.id } : {}) });
  const key = (id) => referenceKey(scope, id, contact?.id);
  const assetIds = new Map((source.assets || []).map((asset) => [asset.id, key(asset.id)]));
  return {
    scope,
    label,
    status: source.status,
    message: source.message || "",
    assets: (source.assets || []).map((asset) => ({
      ...asset,
      scope,
      scopeLabel: label,
      reference: reference(asset.id),
      referenceId: key(asset.id),
      sets: (asset.sets || []).map((setId) => key(setId)),
      setIds: asset.sets || [],
    })),
    sets: (source.sets || []).map((set) => ({
      ...set,
      scope,
      scopeLabel: label,
      reference: reference(set.id),
      setId: set.id,
      referenceId: key(set.id),
      assets: (set.assets || []).map((assetId) => assetIds.get(assetId)).filter(Boolean),
    })),
  };
}

async function snapshotFor(context) {
  const [sharedSnapshot, contactSnapshot] = await Promise.all([
    context.shared.snapshot(),
    context.contactLibrary ? context.contactLibrary.snapshot() : Promise.resolve(null),
  ]);
  const shared = mergeScopeSnapshot("shared", sharedSnapshot, context.contact);
  const contact = contactSnapshot ? mergeScopeSnapshot("contact", contactSnapshot, context.contact) : null;
  const scopes = [shared, ...(contact ? [contact] : [])];
  const assets = scopes.flatMap((scope) => scope.assets);
  const invalid = scopes.filter((scope) => scope.status === "invalid");
  return {
    status: assets.length ? "ready" : invalid.length ? "invalid" : "empty",
    ...(invalid.length ? { message: invalid.map((scope) => `${scope.label}：${scope.message || "资料库无效。"}`).join("；") } : {}),
    contact: context.contact ? { id: context.contact.id, name: context.contact.name, agentId: context.contact.agentId } : null,
    scopes: scopes.map(({ scope, label, status, message }) => ({ scope, label, status, message })),
    assets,
    sets: scopes.flatMap((scope) => scope.sets),
  };
}

export function registerVisualReferencesIpc({ contactProjectsService, dialog, getMainWindow, ipcMain, nativeImage, settingsService }) {
  const selections = new Map();
  const current = () => librariesFor(settingsService, contactProjectsService);
  const consumeSelection = (token) => {
    const selected = selections.get(String(token || ""));
    if (!selected || selected.expiresAt < Date.now()) {
      selections.delete(String(token || ""));
      throw new Error("所选图片已失效，请重新选择。 ");
    }
    return selected;
  };

  ipcMain.handle("visual-references:snapshot", async () => snapshotFor(await current()));
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
    const request = referenceRequest(value);
    const context = await current();
    await libraryForScope(context, request).add({ ...plainObject(value), id: request.id, source: selection.source });
    selections.delete(String(value.selectionToken));
    return snapshotFor(context);
  });
  ipcMain.handle("visual-references:update", async (_event, value) => {
    const request = referenceRequest(value);
    const context = await current();
    await libraryForScope(context, request).update({ ...plainObject(value), id: request.id });
    return snapshotFor(context);
  });
  ipcMain.handle("visual-references:upsert-set", async (_event, value) => {
    const request = referenceRequest(value);
    const context = await current();
    await libraryForScope(context, request).upsertSet({ ...plainObject(value), id: request.id });
    return snapshotFor(context);
  });
  ipcMain.handle("visual-references:remove-set", async (_event, value) => {
    const request = referenceRequest(value);
    const context = await current();
    await libraryForScope(context, request).removeSet(request.id);
    return snapshotFor(context);
  });
  ipcMain.handle("visual-references:remove", async (_event, value) => {
    if (value?.confirmed !== true) throw new Error("移除资料前需要明确确认。 ");
    const request = referenceRequest(value);
    const context = await current();
    await libraryForScope(context, request).remove({ id: request.id, deleteFile: value.deleteFile });
    return snapshotFor(context);
  });
  ipcMain.handle("visual-references:thumbnail", async (_event, value) => {
    const request = referenceRequest(value);
    const context = await current();
    const imagePath = await libraryForScope(context, request).assetPath(request.id);
    const image = nativeImage.createFromPath(imagePath);
    if (image.isEmpty()) throw new Error("无法读取该参考图缩略图。 ");
    return image.resize({ width: 420, height: 420, quality: "good" }).toDataURL();
  });
}
