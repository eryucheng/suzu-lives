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
  const title = mode === "new" ? "添加到表情系统" : "编辑表情信息";
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
        <Status label={tagging ? "正在生成" : mode === "new" ? "回车保存" : "可编辑"} tone={tagging || mode === "new" ? "success" : "muted"} />
      </div>
      <p className="sticker-form-note">裁剪后会自动生成名称、画面说明和检索词；你可以直接修改。</p>
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
          {mode === "edit" && needsCompletion ? <button className="text-button" disabled={busy} onClick={onComplete} type="button">补全信息</button> : null}
          {mode === "new" ? <button className="text-button" disabled={busy} onClick={onCancel} type="button">取消添加</button> : null}
          <button className="primary-button" disabled={busy} type="submit">{busy ? "正在保存…" : mode === "new" ? "保存到表情系统" : "保存修改"}</button>
        </div>
      </footer>
    </form>
  );
}

function StickerLibraryRail({ items, loading, onAdd, onSelect, selectedId }) {
  return (
    <aside className="sticker-library-rail">
      <header>
        <div><span className="reference-kicker">STICKER LIBRARY</span><h2>表情系统</h2></div>
        <button aria-label="添加表情包" className="sticker-add-button" disabled={loading} onClick={onAdd} title="添加表情包" type="button">＋</button>
      </header>
      {items.length ? (
        <div className="sticker-library-grid">
          {items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <button aria-pressed={selected} className={`sticker-library-item${selected ? " is-selected" : ""}`} key={item.id} onClick={() => onSelect(item)} type="button">
                <img alt="" src={item.fileUrl} />
                <span><strong>{item.metadata?.name || item.fileName}</strong><small>{item.metadata?.keywords?.slice(0, 2).join(" · ") || "正在整理"}</small></span>
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
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [snapshot, setSnapshot] = useState({ items: [], status: "empty" });
  const [tagging, setTagging] = useState(false);
  const automaticCompletionIds = useRef(new Set());
  const completionRequest = useRef(0);
  const stickers = api?.conversation?.emojiStickers;

  const applySnapshot = useCallback((next, preferredId = "") => {
    const value = next || { items: [], status: "empty" };
    const items = Array.isArray(value.items) ? value.items : [];
    const targetId = clean(preferredId) || clean(selectedId);
    const selected = items.find((item) => item.id === targetId) || items[0] || null;
    setSnapshot(value);
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

  const changeForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const selectSticker = (item) => {
    if (busy || tagging) return;
    setDraft(null);
    setSelectedId(item.id);
    setForm(formFromMetadata(item.metadata));
    setError("");
    setNotice("");
  };

  const beginAdd = async () => {
    if (busy || tagging || typeof stickers?.select !== "function") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const selection = await stickers.select();
      if (selection?.canceled) return;
      const source = selection.previewDataUrl || selection.fileUrl;
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

  const completeDraft = useCallback(async (nextDraft) => {
    if (!nextDraft || typeof stickers?.complete !== "function") return;
    const requestId = ++completionRequest.current;
    setTagging(true);
    setError("");
    setNotice("正在根据图片生成名称、画面说明和检索词…");
    try {
      const response = await stickers.complete({
        data: nextDraft.data,
        metadata: metadataFromForm(EMPTY_FORM),
        mimeType: nextDraft.mimeType,
        selectionToken: nextDraft.selectionToken,
      });
      if (completionRequest.current !== requestId) return;
      if (!response?.metadata) throw new Error("没有收到表情包信息。");
      setForm(formFromMetadata(response.metadata));
      setNotice("已自动生成表情信息，可以直接修改后保存。");
    } catch (reason) {
      if (completionRequest.current !== requestId) return;
      setNotice("");
      setError(`暂时无法自动生成表情信息：${reason?.message || reason}。你仍可直接填写后保存。`);
    } finally {
      if (completionRequest.current !== requestId) return;
      setTagging(false);
      setDraft((current) => current?.selectionToken === nextDraft.selectionToken
        ? { ...current, autoCompletionAttempted: true }
        : current);
    }
  }, [stickers]);

  const completeSaved = useCallback(async (item, metadata = item?.metadata, { automatic = false } = {}) => {
    if (!item || typeof stickers?.complete !== "function") return;
    const requestId = ++completionRequest.current;
    setTagging(true);
    setError("");
    setNotice(automatic ? "正在补全这张表情包的信息…" : "正在生成名称、画面说明和检索词…");
    try {
      const response = await stickers.complete({ id: item.id, metadata });
      if (completionRequest.current !== requestId) return;
      const completed = applySnapshot(response, item.id);
      setForm(formFromMetadata(completed?.metadata));
      setNotice(automatic ? "已自动补全这张表情包的信息。" : "已补全表情信息，可以继续修改。" );
    } catch (reason) {
      if (completionRequest.current !== requestId) return;
      setNotice("");
      setError(`暂时无法自动生成表情信息：${reason?.message || reason}。你仍可直接填写后保存。`);
    } finally {
      if (completionRequest.current !== requestId) return;
      setTagging(false);
    }
  }, [applySnapshot, stickers]);

  useEffect(() => {
    if (draft || busy || tagging || !selected || typeof stickers?.complete !== "function") return;
    if (!metadataNeedsCompletion(selected.metadata) || automaticCompletionIds.current.has(selected.id)) return;
    automaticCompletionIds.current.add(selected.id);
    void completeSaved(selected, selected.metadata, { automatic: true });
  }, [busy, completeSaved, draft, selected, stickers, tagging]);

  const confirmCrop = (image, value) => {
    try {
      const output = squareStickerFromElement(image, value);
      if (draft?.selectionToken) void stickers.discardSelection?.({ selectionToken: draft.selectionToken }).catch(() => undefined);
      const nextDraft = { ...output, selectionToken: crop.selection.selectionToken };
      setDraft(nextDraft);
      setCrop(null);
      setSelectedId("");
      setForm({ ...EMPTY_FORM });
      setError("");
      void completeDraft(nextDraft);
    } catch (reason) {
      setError(`无法裁剪表情包：${reason?.message || reason}`);
    }
  };

  const submit = async () => {
    if (busy || tagging) return;
    const savingDraft = draft;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let response;
      if (savingDraft) {
        response = await stickers.add({
          autoCompletionAttempted: savingDraft.autoCompletionAttempted === true,
          data: savingDraft.data,
          metadata: metadataFromForm(form),
          mimeType: savingDraft.mimeType,
          selectionToken: savingDraft.selectionToken,
        });
      } else if (selected) {
        response = await stickers.update({ id: selected.id, metadata: metadataFromForm(form) });
      } else {
        return;
      }
      const selectedAfterSave = applySnapshot(response, response.addedId || response.updatedId);
      setDraft(null);
      setForm(formFromMetadata(selectedAfterSave?.metadata));
      if (response.tagging?.status === "failed") setNotice(`表情包已保存；${response.tagging.message}`);
      else setNotice(savingDraft ? "表情包已保存。" : "表情信息已更新。");
    } catch (reason) {
      setError(`无法保存表情包：${reason?.message || reason}`);
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (!selected || busy || tagging || !window.confirm(`确定删除“${selected.metadata?.name || selected.fileName}”吗？`)) return;
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

  const preview = draft?.previewDataUrl || selected?.fileUrl || "";
  const mode = draft ? "new" : "edit";

  return (
    <PageScaffold
      canvasClassName="page-canvas--fill"
      className="create-sticker-react-page"
      header={(
        <PageHeader
          action={<div className="create-subpage-actions"><button className="secondary-button" onClick={actions.returnToOverview} type="button">返回创造</button><button className="primary-button" disabled={busy || tagging} onClick={() => { void beginAdd(); }} type="button">添加表情包</button></div>}
          eyebrow="CREATE / STICKERS"
          subtitle="整理自定义表情的图片、说明与检索词，让聊天与 Agent 共用同一套表情系统。"
          title="表情包工作台"
        />
      )}
    >
      {error ? <div className="sticker-workbench-feedback is-error" role="alert">{error}</div> : null}
      {notice ? <div className="sticker-workbench-feedback" role="status">{notice}</div> : null}
      <div className="sticker-workbench">
        <StickerLibraryRail items={snapshot.items || []} loading={loading || busy || tagging} onAdd={() => { void beginAdd(); }} onSelect={selectSticker} selectedId={selectedId} />
        <main className="sticker-editor-panel">
          {preview ? (
            <>
              <div className="sticker-editor-preview">
                <div><img alt={draft ? "新表情包预览" : selected?.metadata?.name || selected?.fileName || "表情包预览"} src={preview} /></div>
                <p>{draft ? tagging ? "正在根据图片生成表情信息…" : "已完成正方形裁剪，可以直接修改后保存。" : selected?.fileName}</p>
              </div>
              <StickerMetadataForm
                busy={busy || tagging}
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
                tagging={tagging}
              />
            </>
          ) : (
            <div className="sticker-editor-empty">
              <span aria-hidden="true">＋</span>
              <h2>添加一张表情包</h2>
              <p>选择本机图片后先裁成正方形，系统会自动生成可编辑的信息。</p>
              <button className="primary-button" disabled={busy || tagging} onClick={() => { void beginAdd(); }} type="button">选择图片</button>
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
