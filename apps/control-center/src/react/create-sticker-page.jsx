import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PageHeader, Status } from "suzu-design-system";

import {
  AVATAR_CROP_MAX_ZOOM,
  AVATAR_CROP_MIN_ZOOM,
  AVATAR_CROP_OUTPUT_SIZE,
  avatarCropLayout,
  avatarCropSourceRect,
  createSquareAvatarCrop,
  moveAvatarCrop,
  resizeAvatarCropViewport,
  setAvatarCropZoom,
} from "../core/avatar-file.mjs";
import { releasePointerCapture } from "../core/pointer-capture.mjs";
import { stickerMetadataFormIsEmpty } from "../features/create/sticker-form.mjs";
import { PageScaffold } from "./page-scaffold.jsx";
import { usePointerCaptureRecovery } from "./pointer-capture-recovery.mjs";

const EMPTY_FORM = Object.freeze({
  description: "",
  keywords: "",
  name: "",
});

function clean(value) {
  return String(value ?? "").trim();
}

function keywordText(value) {
  return (Array.isArray(value) ? value : [])
    .map(clean)
    .filter(Boolean)
    .join("、");
}

function formFromMetadata(value = {}) {
  return {
    description: clean(value.description),
    keywords: keywordText(value.keywords),
    name: clean(value.name),
  };
}

function metadataFromForm(form) {
  return {
    description: clean(form.description),
    keywords: form.keywords,
    name: clean(form.name),
  };
}

function metadataNeedsCompletion(value = {}) {
  const keywords = Array.isArray(value.keywords)
    ? value.keywords.map(clean).filter(Boolean)
    : String(value.keywords || "").split(/[，,、\n]/u).map(clean).filter(Boolean);
  return !clean(value.name) || !clean(value.description) || !keywords.length;
}

function loadImageDimensions(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const imageWidth = Number(image.naturalWidth || image.width);
      const imageHeight = Number(image.naturalHeight || image.height);
      if (!imageWidth || !imageHeight) reject(new Error("无法读取这张图片的尺寸。"));
      else resolve({ imageHeight, imageWidth });
    }, { once: true });
    image.addEventListener("error", () => reject(new Error("无法打开这张图片。")), { once: true });
    image.src = source;
  });
}

function dataUrlBytes(dataUrl) {
  const encoded = String(dataUrl || "").split(",", 2)[1] || "";
  const binary = window.atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function squareStickerFromElement(image, crop) {
  if (!image?.naturalWidth || !image?.naturalHeight) throw new Error("图片尚未准备好，请稍后重试。");
  const source = avatarCropSourceRect(crop);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_CROP_OUTPUT_SIZE;
  canvas.height = AVATAR_CROP_OUTPUT_SIZE;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("当前环境无法裁剪表情包。");
  drawing.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
  const previewDataUrl = canvas.toDataURL("image/webp", .92);
  return {
    data: dataUrlBytes(previewDataUrl),
    mimeType: "image/webp",
    previewDataUrl,
  };
}

function StickerCropDialog({ crop, onCancel, onConfirm }) {
  const dragRef = useRef(null);
  const imageRef = useRef(null);
  const stageRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [workingCrop, setWorkingCrop] = useState(crop);

  useEffect(() => {
    setWorkingCrop(crop);
    setImageReady(false);
  }, [crop?.source]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !workingCrop) return undefined;
    const measure = () => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        setWorkingCrop((current) => resizeAvatarCropViewport(current, bounds.width, bounds.height));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [crop?.source]);

  const endDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    setDragging(false);
    releasePointerCapture(stageRef.current, drag.pointerId);
  };

  usePointerCaptureRecovery(() => endDrag());

  if (!crop || !workingCrop) return null;
  const layout = avatarCropLayout(workingCrop);
  const beginDrag = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWorkingCrop((current) => moveAvatarCrop(current, event.clientX - drag.x, event.clientY - drag.y));
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
  };

  return (
    <div className="sticker-crop-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} role="presentation">
      <section aria-labelledby="stickerCropTitle" aria-modal="true" className="sticker-crop-dialog" role="dialog">
        <header>
          <div><span>STICKER CROP</span><h2 id="stickerCropTitle">裁剪表情包</h2></div>
          <button aria-label="取消裁剪" className="sticker-close-button" onClick={onCancel} type="button">×</button>
        </header>
        <p>拖动和缩放图片，方框内区域会统一保存为 512 × 512 的表情图。</p>
        <div
          aria-label="表情包裁剪区域"
          className={`sticker-crop-stage${dragging ? " is-dragging" : ""}`}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          ref={stageRef}
        >
          <img
            alt="正在裁剪的表情包"
            draggable="false"
            onLoad={() => setImageReady(true)}
            ref={imageRef}
            src={workingCrop.source}
            style={{
              height: `${layout.displayHeight}px`,
              transform: `translate(${layout.offsetX}px, ${layout.offsetY}px)`,
              width: `${layout.displayWidth}px`,
            }}
          />
          <span aria-hidden="true" className="sticker-crop-frame" />
        </div>
        <label className="sticker-crop-zoom">
          <span>缩放</span>
          <input
            max={AVATAR_CROP_MAX_ZOOM}
            min={AVATAR_CROP_MIN_ZOOM}
            onChange={(event) => {
              const zoom = event.currentTarget.value;
              setWorkingCrop((current) => setAvatarCropZoom(current, zoom));
            }}
            step="0.01"
            type="range"
            value={layout.zoom}
          />
          <output>{Math.round(layout.zoom * 100)}%</output>
        </label>
        <footer>
          <button className="text-button" onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={!imageReady} onClick={() => onConfirm(imageRef.current, workingCrop)} type="button">确认裁剪</button>
        </footer>
      </section>
    </div>
  );
}

function StickerMetadataForm({ busy, form, mode, needsCompletion, onCancel, onChange, onComplete, onDelete, onSubmit, tagging }) {
  const empty = stickerMetadataFormIsEmpty(form);
  const title = mode === "new" ? "添加到表情系统" : "编辑表情信息";
  const submitLabel = tagging
    ? "正在生成…"
    : busy
      ? "正在保存…"
      : empty
        ? mode === "new" ? "保存并后台生成" : "生成表情信息"
        : mode === "new"
          ? "保存到表情系统"
          : "保存修改";
  return (
    <form
      className="sticker-metadata-form"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }}
      onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}
    >
      <div className="sticker-editor-heading">
        <div><span className="reference-kicker">{mode === "new" ? "NEW STICKER" : "STICKER INFO"}</span><h2>{title}</h2></div>
        <Status label={tagging ? "后台生成中" : empty ? mode === "new" ? "回车保存并生成" : "回车生成" : mode === "new" ? "回车保存" : "可编辑"} tone={tagging || empty || mode === "new" ? "success" : "muted"} />
      </div>
      <p className="sticker-form-note">三项都不填写时按回车，会先保存图片并在后台生成信息，可以立即继续添加下一张；手动填写任一项后按回车会直接保存。</p>
      <div className="sticker-form-grid">
        <label className="sticker-form-field sticker-form-field--wide">
          <span>名称</span>
          <input autoComplete="off" disabled={busy} maxLength="80" onChange={(event) => onChange("name", event.currentTarget.value)} placeholder="例如：猫猫震惊" value={form.name} />
        </label>
        <label className="sticker-form-field sticker-form-field--wide">
          <span>画面与用法</span>
          <textarea disabled={busy} maxLength="280" onChange={(event) => onChange("description", event.currentTarget.value)} placeholder="一句话说明画面，以及适合在什么情况下发送" rows="2" value={form.description} />
        </label>
        <label className="sticker-form-field sticker-form-field--wide">
          <span>检索词</span>
          <input autoComplete="off" disabled={busy} maxLength="420" onChange={(event) => onChange("keywords", event.currentTarget.value)} placeholder="用逗号或换行分隔，例如：杰瑞、墨镜、得意" value={form.keywords} />
        </label>
      </div>
      <footer className="sticker-form-actions">
        <div>
          {mode === "edit" ? <button className="sticker-danger-button" disabled={busy} onClick={onDelete} type="button">删除表情包</button> : null}
        </div>
        <div>
          {mode === "edit" && needsCompletion && !empty ? <button className="text-button" disabled={busy} onClick={onComplete} type="button">补全信息</button> : null}
          {mode === "new" ? <button className="text-button" disabled={busy} onClick={onCancel} type="button">取消添加</button> : null}
          <button className="primary-button" disabled={busy} type="submit">{submitLabel}</button>
        </div>
      </footer>
    </form>
  );
}

function StickerLibraryRail({
  batchEditing,
  batchSelectedIds,
  batchUnavailable,
  completingIds,
  items,
  loading,
  onAdd,
  onCancelBatch,
  onSelect,
  onStartBatch,
  onToggleBatch,
  onToggleBatchAll,
  selectedId,
}) {
  const selectableBatchIds = items
    .filter((item) => !completingIds.has(item.id))
    .map((item) => item.id);
  const allBatchSelected = selectableBatchIds.length > 0
    && selectableBatchIds.every((id) => batchSelectedIds.has(id));
  return (
    <aside className="sticker-library-rail">
      <header>
        <div><span className="reference-kicker">STICKER LIBRARY</span><h2>表情系统</h2></div>
        <div className="sticker-library-header-actions">
          {items.length ? (
            <button
              className={`sticker-batch-mode-button${batchEditing ? " is-active" : ""}`}
              disabled={loading || (!batchEditing && batchUnavailable)}
              onClick={batchEditing ? onCancelBatch : onStartBatch}
              title={!batchEditing && batchUnavailable ? "请先保存或取消当前新增表情包" : undefined}
              type="button"
            >{batchEditing ? "完成" : "批量编辑"}</button>
          ) : null}
          {!batchEditing ? <button aria-label="添加表情包" className="sticker-add-button" disabled={loading} onClick={onAdd} title="添加表情包" type="button">＋</button> : null}
        </div>
      </header>
      {batchEditing && items.length ? (
        <div className="sticker-library-batch-toolbar">
          <span>已选择 <strong>{batchSelectedIds.size}</strong> 张</span>
          <button
            disabled={loading || !selectableBatchIds.length}
            onClick={() => onToggleBatchAll(selectableBatchIds, allBatchSelected)}
            type="button"
          >{allBatchSelected ? "取消全选" : "全选"}</button>
        </div>
      ) : null}
      {items.length ? (
        <div className="sticker-library-grid">
          {items.map((item) => {
            const completing = completingIds.has(item.id);
            const batchSelected = batchSelectedIds.has(item.id);
            const selected = !batchEditing && item.id === selectedId;
            const label = item.metadata?.name || item.fileName || "表情包";
            return (
              <button
                aria-label={batchEditing ? `${batchSelected ? "取消选择" : "选择"}“${label}”` : `编辑“${label}”`}
                aria-pressed={batchEditing ? batchSelected : selected}
                className={`sticker-library-item${selected ? " is-selected" : ""}${batchSelected ? " is-batch-selected" : ""}`}
                disabled={loading || (batchEditing && completing)}
                key={item.id}
                onClick={() => { if (batchEditing) onToggleBatch(item); else onSelect(item); }}
                title={batchEditing && completing ? "正在后台生成信息，暂时不能选择" : label}
                type="button"
              >
                {batchEditing ? <span aria-hidden="true" className={`sticker-library-checkbox${batchSelected ? " is-checked" : ""}`}>{batchSelected ? "✓" : ""}</span> : null}
                <img alt="" src={item.fileUrl} />
                <span className="sticker-library-item-copy"><strong>{label}</strong><small>{completing ? "正在后台生成信息" : item.metadata?.keywords?.slice(0, 2).join(" · ") || "尚未填写信息"}</small></span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="sticker-library-empty">
          <span aria-hidden="true">☺</span>
          <strong>{loading ? "正在读取" : "还没有自定义表情包"}</strong>
          <p>从本机添加一张图片，裁成正方形后就会进入这里。</p>
          <button className="secondary-button" disabled={loading} onClick={onAdd} type="button">添加第一张</button>
        </div>
      )}
    </aside>
  );
}

export function CreateStickerPage({ actions = {}, api = {} }) {
  const [batchEditing, setBatchEditing] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [completingIds, setCompletingIds] = useState(() => new Set());
  const [crop, setCrop] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [snapshot, setSnapshot] = useState({ items: [], status: "empty" });
  const completingIdsRef = useRef(new Set());
  const draftRef = useRef(draft);
  const selectedIdRef = useRef(selectedId);
  const stickers = api?.conversation?.emojiStickers;
  draftRef.current = draft;
  selectedIdRef.current = selectedId;

  const setCompletionPending = useCallback((id, pending) => {
    const next = new Set(completingIdsRef.current);
    if (pending) next.add(id);
    else next.delete(id);
    completingIdsRef.current = next;
    setCompletingIds(next);
  }, []);

  const applySnapshot = useCallback((next, preferredId = "") => {
    const value = next || { items: [], status: "empty" };
    const items = Array.isArray(value.items) ? value.items : [];
    const targetId = clean(preferredId) || clean(selectedId);
    const selected = items.find((item) => item.id === targetId) || items[0] || null;
    setSnapshot(value);
    selectedIdRef.current = selected?.id || "";
    setSelectedId(selected?.id || "");
    if (!draft) setForm(formFromMetadata(selected?.metadata));
    return selected;
  }, [draft, selectedId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.resolve(stickers?.snapshot?.())
      .then((value) => { if (active) applySnapshot(value); })
      .catch((reason) => { if (active) setError(`无法读取表情系统：${reason?.message || reason}`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [stickers]);

  const selected = useMemo(
    () => (snapshot.items || []).find((item) => item.id === selectedId) || null,
    [selectedId, snapshot.items],
  );
  const selectedTagging = Boolean(selectedId && completingIds.has(selectedId));
  const batchSelectedCount = batchSelectedIds.size;

  const changeForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const selectSticker = (item) => {
    if (batchEditing || busy) return;
    draftRef.current = null;
    selectedIdRef.current = item.id;
    setDraft(null);
    setSelectedId(item.id);
    setForm(formFromMetadata(item.metadata));
    setError("");
    setNotice("");
  };

  const startBatchEdit = () => {
    if (busy || draft || crop) return;
    setBatchSelectedIds(new Set());
    setBatchEditing(true);
    setError("");
    setNotice("");
  };

  const cancelBatchEdit = () => {
    if (busy) return;
    setBatchSelectedIds(new Set());
    setBatchEditing(false);
  };

  const toggleBatchSticker = (item) => {
    const id = clean(item?.id);
    if (!batchEditing || busy || !id || completingIdsRef.current.has(id)) return;
    setBatchSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleBatchAll = (ids, clear) => {
    if (!batchEditing || busy) return;
    setBatchSelectedIds(clear ? new Set() : new Set(ids.map(clean).filter(Boolean)));
  };

  const beginAdd = async () => {
    if (batchEditing || busy || typeof stickers?.select !== "function") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const selection = await stickers.select();
      if (selection?.canceled) return;
      const source = clean(selection.fileUrl);
      if (!source) throw new Error("没有收到所选表情包的本地地址。");
      const dimensions = await loadImageDimensions(source);
      setCrop({
        selection,
        value: createSquareAvatarCrop({ source, ...dimensions }),
      });
    } catch (reason) {
      setError(`无法添加表情包：${reason?.message || reason}`);
    } finally {
      setBusy(false);
    }
  };

  const applyCompletionSnapshot = useCallback((next, itemId) => {
    const value = next || { items: [], status: "empty" };
    const items = Array.isArray(value.items) ? value.items : [];
    const completed = items.find((item) => item.id === itemId) || null;
    setSnapshot(value);
    if (!draftRef.current && selectedIdRef.current === itemId) {
      setForm(formFromMetadata(completed?.metadata));
    }
    return completed;
  }, []);

  const completeSaved = useCallback(async (item, metadata = item?.metadata, { background = false } = {}) => {
    const itemId = clean(item?.id);
    if (!itemId || completingIdsRef.current.has(itemId)) return;
    if (typeof stickers?.complete !== "function") {
      setError("当前版本无法生成表情信息，请先手动填写。");
      return;
    }
    const itemLabel = clean(item?.metadata?.name) || clean(item?.fileName) || "表情包";
    setCompletionPending(itemId, true);
    if (!background) {
      setError("");
      setNotice("正在生成名称、画面说明和检索词；你可以继续添加其他表情包。");
    }
    try {
      const response = await stickers.complete({ id: itemId, metadata });
      const completed = applyCompletionSnapshot(response, itemId);
      const completedLabel = clean(completed?.metadata?.name) || itemLabel;
      setNotice(`“${completedLabel}”的信息已生成并自动保存。`);
    } catch (reason) {
      setError(`“${itemLabel}”暂时无法生成表情信息：${reason?.message || reason}。图片已经保存，可以稍后补全。`);
    } finally {
      setCompletionPending(itemId, false);
    }
  }, [applyCompletionSnapshot, setCompletionPending, stickers]);

  const confirmCrop = (image, value) => {
    try {
      const output = squareStickerFromElement(image, value);
      if (draft?.selectionToken) void stickers.discardSelection?.({ selectionToken: draft.selectionToken }).catch(() => undefined);
      const nextDraft = { ...output, selectionToken: crop.selection.selectionToken };
      draftRef.current = nextDraft;
      selectedIdRef.current = "";
      setDraft(nextDraft);
      setCrop(null);
      setSelectedId("");
      setForm({ ...EMPTY_FORM });
      setError("");
      setNotice("");
    } catch (reason) {
      setError(`无法裁剪表情包：${reason?.message || reason}`);
    }
  };

  const submit = async () => {
    if (busy || selectedTagging) return;
    const metadata = metadataFromForm(form);
    const empty = stickerMetadataFormIsEmpty(form);
    if (!draft && empty) {
      if (selected) await completeSaved(selected, metadata);
      return;
    }
    const savingDraft = draft;
    const generateAfterSave = Boolean(savingDraft && empty);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let response;
      if (savingDraft) {
        response = await stickers.add({
          data: savingDraft.data,
          metadata,
          mimeType: savingDraft.mimeType,
          selectionToken: savingDraft.selectionToken,
        });
      } else if (selected) {
        response = await stickers.update({ id: selected.id, metadata });
      } else {
        return;
      }
      const selectedAfterSave = applySnapshot(response, response.addedId || response.updatedId);
      draftRef.current = null;
      setDraft(null);
      setForm(formFromMetadata(selectedAfterSave?.metadata));
      if (generateAfterSave && selectedAfterSave) {
        setNotice("表情包已保存，正在后台生成信息；现在可以继续添加下一张。");
        void completeSaved(selectedAfterSave, selectedAfterSave.metadata, { background: true });
      } else {
        setNotice(savingDraft ? "表情包已保存。" : "表情信息已更新。");
      }
    } catch (reason) {
      setError(`无法保存表情包：${reason?.message || reason}`);
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (batchEditing || !selected || busy || selectedTagging || !window.confirm(`确定删除“${selected.metadata?.name || selected.fileName}”吗？`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await stickers.remove({ confirmed: true, id: selected.id });
      setDraft(null);
      const next = applySnapshot(response);
      setForm(formFromMetadata(next?.metadata));
      setNotice("表情包已删除。");
    } catch (reason) {
      setError(`无法删除表情包：${reason?.message || reason}`);
    } finally {
      setBusy(false);
    }
  };

  const removeBatchSelected = async () => {
    const selectedItems = (snapshot.items || []).filter((item) => (
      batchSelectedIds.has(item.id) && !completingIdsRef.current.has(item.id)
    ));
    if (!batchEditing || busy || !selectedItems.length) return;
    if (typeof stickers?.remove !== "function") {
      setError("当前版本无法删除表情包。");
      return;
    }
    if (!window.confirm(`确定删除选中的 ${selectedItems.length} 张表情包吗？删除后无法恢复。`)) return;

    setBusy(true);
    setError("");
    setNotice("");
    let latestSnapshot = null;
    const removedIds = new Set();
    try {
      for (const item of selectedItems) {
        latestSnapshot = await stickers.remove({ confirmed: true, id: item.id });
        removedIds.add(item.id);
      }
      setDraft(null);
      const next = applySnapshot(latestSnapshot);
      setForm(formFromMetadata(next?.metadata));
      setBatchSelectedIds(new Set());
      setBatchEditing(false);
      setNotice(`已删除 ${removedIds.size} 张表情包。`);
    } catch (reason) {
      if (latestSnapshot) {
        const next = applySnapshot(latestSnapshot);
        setForm(formFromMetadata(next?.metadata));
      }
      setBatchSelectedIds((current) => new Set([...current].filter((id) => !removedIds.has(id))));
      setError(removedIds.size
        ? `已删除 ${removedIds.size} 张，其余表情包未删除：${reason?.message || reason}`
        : `无法批量删除表情包：${reason?.message || reason}`);
    } finally {
      setBusy(false);
    }
  };

  const preview = draft?.previewDataUrl || selected?.fileUrl || "";
  const mode = draft ? "new" : "edit";

  return (
    <PageScaffold
      canvasClassName="page-canvas--fill"
      className="create-sticker-react-page"
      header={(
        <PageHeader
          action={<div className="create-subpage-actions"><button className="secondary-button" onClick={actions.returnToOverview} type="button">返回创造</button><button className="primary-button" disabled={busy || batchEditing} onClick={() => { void beginAdd(); }} type="button">添加表情包</button></div>}
          eyebrow="CREATE / STICKERS"
          subtitle="整理自定义表情的图片、说明与检索词，让聊天与 Agent 共用同一套表情系统。"
          title="表情包工作台"
        />
      )}
    >
      {error ? <div className="sticker-workbench-feedback is-error" role="alert">{error}</div> : null}
      {notice ? <div className="sticker-workbench-feedback" role="status">{notice}</div> : null}
      <div className="sticker-workbench">
        <StickerLibraryRail
          batchEditing={batchEditing}
          batchSelectedIds={batchSelectedIds}
          batchUnavailable={Boolean(draft || crop)}
          completingIds={completingIds}
          items={snapshot.items || []}
          loading={loading || busy}
          onAdd={() => { void beginAdd(); }}
          onCancelBatch={cancelBatchEdit}
          onSelect={selectSticker}
          onStartBatch={startBatchEdit}
          onToggleBatch={toggleBatchSticker}
          onToggleBatchAll={toggleBatchAll}
          selectedId={selectedId}
        />
        <main className="sticker-editor-panel">
          {batchEditing ? (
            <div className="sticker-editor-empty sticker-batch-editor">
              <span aria-hidden="true">✓</span>
              <h2>批量编辑</h2>
              <p>{batchSelectedCount ? `已选择 ${batchSelectedCount} 张表情包。确认选择后，再执行统一操作。` : "点击左侧表情卡片右上角的方框，可以选择多张表情包。"}</p>
              <div className="sticker-batch-editor-actions">
                <button className="secondary-button" disabled={busy} onClick={cancelBatchEdit} type="button">完成</button>
                <button className="sticker-danger-button" disabled={busy || !batchSelectedCount} onClick={() => { void removeBatchSelected(); }} type="button">删除所选{batchSelectedCount ? `（${batchSelectedCount}）` : ""}</button>
              </div>
            </div>
          ) : preview ? (
            <>
              <div className="sticker-editor-preview">
                <div className="sticker-editor-preview-image"><img alt={draft ? "新表情包预览" : selected?.metadata?.name || selected?.fileName || "表情包预览"} src={preview} /></div>
                <div className="sticker-editor-preview-copy">
                  <span className="reference-kicker">{draft ? "NEW STICKER" : "SELECTED STICKER"}</span>
                  <strong>{clean(form.name) || (draft ? "新表情包" : selected?.fileName || "当前表情包")}</strong>
                  <p>{draft ? "已完成正方形裁剪；全部留空按回车会保存并在后台生成，可以立即继续添加下一张。" : selectedTagging ? "正在后台生成信息；你可以继续添加其他表情包。" : selected?.fileName}</p>
                </div>
              </div>
              <StickerMetadataForm
                busy={busy || selectedTagging}
                form={form}
                mode={mode}
                needsCompletion={metadataNeedsCompletion(form)}
                onCancel={() => {
                  const next = (snapshot.items || [])[0] || null;
                  if (draft?.selectionToken) void stickers.discardSelection?.({ selectionToken: draft.selectionToken }).catch(() => undefined);
                  setDraft(null);
                  setSelectedId(next?.id || "");
                  setForm(formFromMetadata(next?.metadata));
                }}
                onChange={changeForm}
                onComplete={() => { if (selected) void completeSaved(selected, metadataFromForm(form)); }}
                onDelete={() => { void removeSelected(); }}
                onSubmit={submit}
                tagging={selectedTagging}
              />
            </>
          ) : (
            <div className="sticker-editor-empty">
              <span aria-hidden="true">＋</span>
              <h2>添加一张表情包</h2>
              <p>选择本机图片并裁成正方形后，可以手动填写；全部留空按回车会保存并在后台生成信息。</p>
              <button className="primary-button" disabled={busy} onClick={() => { void beginAdd(); }} type="button">选择图片</button>
            </div>
          )}
        </main>
      </div>
      <StickerCropDialog
        crop={crop?.value || null}
        onCancel={() => {
          if (crop?.selection?.selectionToken) void stickers.discardSelection?.({ selectionToken: crop.selection.selectionToken }).catch(() => undefined);
          setCrop(null);
        }}
        onConfirm={confirmCrop}
      />
    </PageScaffold>
  );
}
