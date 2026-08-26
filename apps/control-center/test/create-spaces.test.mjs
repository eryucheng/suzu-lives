import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PRODUCT_FEATURES } from "../shared/product-features.mjs";
import { CREATE_SPACES } from "../src/features/create/overview.mjs";
import { stickerMetadataFormIsEmpty } from "../src/features/create/sticker-form.mjs";

test("create overview exposes the active creation workbenches", () => {
  assert.equal(PRODUCT_FEATURES.customEmojiStickers, true);
  assert.deepEqual(
    CREATE_SPACES.map(({ id, title }) => ({ id, title })),
    [
      { id: "visual", title: "视觉工作台" },
      { id: "stickers", title: "表情包工作台" },
    ],
  );
  assert.equal(CREATE_SPACES.length, 2);
  assert.ok(CREATE_SPACES.every((space) => space.label && space.detail));
  assert.ok(CREATE_SPACES.every((space) => !space.title.includes("视频")));
});

test("sticker workbench keeps square crop, editable information, and background completion in one React page", async () => {
  const ipc = await readFile(new URL("../electron/ipc/conversation-ipc.mjs", import.meta.url), "utf8");
  const stickers = await readFile(new URL("../src/react/create-sticker-page.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles/create.css", import.meta.url), "utf8");
  assert.match(stickers, /createSquareAvatarCrop/u);
  assert.match(stickers, /avatarCropSourceRect/u);
  assert.match(stickers, /AVATAR_CROP_OUTPUT_SIZE/u);
  assert.match(stickers, /emojiStickers/u);
  assert.match(stickers, /三项都不填写时按回车，会先保存图片并在后台生成信息，可以立即继续添加下一张/u);
  assert.match(stickers, /stickers\.complete/u);
  assert.match(stickers, /const generateAfterSave = Boolean\(savingDraft && empty\);/u);
  assert.match(stickers, /void completeSaved\(selectedAfterSave, selectedAfterSave\.metadata, \{ background: true \}\);/u);
  assert.match(stickers, /const \[completingIds, setCompletingIds\] = useState/u);
  assert.match(stickers, /<button className="primary-button" disabled=\{busy\} onClick=\{\(\) => \{ void beginAdd\(\); \}\} type="button">添加表情包<\/button>/u);
  assert.doesNotMatch(stickers, /completeDraft/u);
  assert.doesNotMatch(stickers, /automaticCompletionIds/u);
  assert.doesNotMatch(stickers, /autoCompletionAttempted/u);
  const addHandlerStart = ipc.indexOf('registerStickerIpcHandler("conversation:add-emoji-sticker"');
  const addHandlerEnd = ipc.indexOf('registerStickerIpcHandler("conversation:complete-emoji-sticker"');
  assert.ok(addHandlerStart >= 0 && addHandlerEnd > addHandlerStart);
  const addHandler = ipc.slice(addHandlerStart, addHandlerEnd);
  assert.doesNotMatch(addHandler, /completeEmojiStickerMetadata/u);
  assert.doesNotMatch(stickers, /表达意图/u);
  assert.doesNotMatch(stickers, /主要情绪/u);
  assert.doesNotMatch(stickers, /sticker-tag-suggestions/u);
  assert.match(stickers, /requestSubmit/u);
  assert.match(stickers, /const source = clean\(selection\.fileUrl\);/u);
  assert.doesNotMatch(ipc, /previewDataUrl:\s*`data:/u);
  assert.match(stickers, /const zoom = event\.currentTarget\.value;\s*setWorkingCrop\(\(current\) => setAvatarCropZoom\(current, zoom\)\);/u);
  assert.doesNotMatch(stickers, /setWorkingCrop\(\(current\) => setAvatarCropZoom\(current, event\.currentTarget\.value\)\)/u);
  assert.match(styles, /\.sticker-workbench\s*\{[\s\S]*?grid-template-columns:\s*minmax\(250px, \.28fr\) minmax\(0, 1fr\);/u);
  assert.match(styles, /\.sticker-editor-panel\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/u);
  assert.match(styles, /\.sticker-editor-preview\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--line\);/u);
  assert.doesNotMatch(styles, /\.sticker-editor-panel\s*\{[^}]*grid-template-columns:/u);
  assert.doesNotMatch(styles, /\.sticker-library-rail\s*\{[^}]*display:\s*none;/u);
});

test("sticker metadata calls generation only for a completely blank submitted form", () => {
  assert.equal(stickerMetadataFormIsEmpty({ description: "", keywords: "", name: "" }), true);
  assert.equal(stickerMetadataFormIsEmpty({ description: "  ", keywords: "\n", name: "\t" }), true);
  assert.equal(stickerMetadataFormIsEmpty({ description: "手动说明", keywords: "", name: "" }), false);
  assert.equal(stickerMetadataFormIsEmpty({ description: "", keywords: "开心", name: "" }), false);
  assert.equal(stickerMetadataFormIsEmpty({ description: "", keywords: "", name: "手动名称" }), false);
});

test("visual workbench keeps its real image and visual-reference flows in the React page", async () => {
  const visual = await readFile(new URL("../src/react/create-visual-page.jsx", import.meta.url), "utf8");
  assert.match(visual, /PageHeader/u);
  assert.match(visual, /绘画提示词/u);
  assert.match(visual, /本次参考/u);
  assert.match(visual, /referenceCapability/u);
  assert.match(visual, /当前模型已禁用参考图/u);
  assert.match(visual, /候选结果/u);
  assert.match(visual, /api\.imageWorkbench\.generate/u);
  assert.match(visual, /api\.imageWorkbench\.thumbnail/u);
  assert.match(visual, /api\.visualReferences\.add/u);
  assert.match(visual, /api\.visualReferences\.update/u);
  assert.match(visual, /api\.visualReferences\.upsertSet/u);
  assert.match(visual, /reference-select-square/u);
  assert.match(visual, /CreateStudioDialog/u);
  assert.doesNotMatch(visual, /renderDrawing/u);
  assert.doesNotMatch(visual, /bindDrawingEvents/u);
});

test("voice message settings own voice management and contact assignment in the React page", async () => {
  const detail = await readFile(new URL("../src/react/capability-detail-page.jsx", import.meta.url), "utf8");
  assert.match(detail, /配置联系人音色/u);
  assert.match(detail, /新增音色/u);
  assert.match(detail, /音色 ID/u);
  assert.match(detail, /voiceDesign\?\.snapshot/u);
  assert.match(detail, /voiceDesign\?\.saveService/u);
  assert.match(detail, /voiceDesign\?\.saveProfile/u);
  assert.match(detail, /voiceDesign\?\.saveCustomTtsAdapter/u);
  assert.match(detail, /voiceDesign\?\.deleteCustomVoice/u);
  assert.match(detail, /voiceDesign\.saveContactVoice/u);
  assert.match(detail, /CreateStudioDialog/u);
  assert.doesNotMatch(detail, /api\.voiceDesign\.create/u);
  assert.doesNotMatch(detail, /api\.voiceDesign\.preview/u);
  assert.doesNotMatch(detail, /retainCandidate/u);
});
