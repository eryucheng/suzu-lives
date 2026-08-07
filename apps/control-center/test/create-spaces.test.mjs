import assert from "node:assert/strict";
import test from "node:test";

import { renderVoiceDesign } from "../src/features/create/audio.mjs";
import { renderCreateOverview } from "../src/features/create/overview.mjs";
import { renderCreate } from "../src/features/create/index.mjs";
import { renderDrawing } from "../src/features/create/drawing.mjs";

test("create overview exposes visual workbench and voice design as separate real subspaces", () => {
  const view = renderCreateOverview();
  assert.match(view, /视觉工作台/);
  assert.match(view, /音色设计/);
  assert.match(view, /<button class="create-space-card" data-open-create-space="visual"/);
  assert.match(view, /<button class="create-space-card" data-open-create-space="audio"/);
  assert.match(view, /data-open-create-space="visual"/);
  assert.match(view, /data-open-create-space="audio"/);
  assert.equal((view.match(/class="create-space-card"/g) || []).length, 2);
  assert.doesNotMatch(view, /create-space-tabs|create-mode-switch/);
  assert.doesNotMatch(view, /视频/);
});

test("visual workbench keeps high-frequency creation visible and moves settings behind a compact entry", () => {
  const drawing = renderDrawing();
  assert.match(drawing, /视觉工作台/);
  assert.match(drawing, /绘画提示词/);
  assert.match(drawing, /本次参考/);
  assert.match(drawing, /在下方视觉参考库按分类浏览图片/);
  assert.match(drawing, /从资料库挑选本次参考/);
  assert.doesNotMatch(drawing, /drawing-reference-picks/);
  assert.match(drawing, /候选结果/);
  assert.match(drawing, /data-open-drawing-settings/);
  assert.match(drawing, /aria-label="绘画设置"/);
  assert.match(drawing, /<dialog id="drawingSettingsDialog" class="create-settings-dialog"/);
  assert.match(drawing, /data-close-drawing-settings/);
  assert.doesNotMatch(drawing, /<dialog[^>]+id="drawingSettingsDialog"[^>]*\sopen(?:\s|>)/);
  assert.match(drawing, /绘画设置/);
  assert.match(drawing, /云端图像 API/);
  assert.match(drawing, /本机 ComfyUI/);
  assert.match(drawing, /生成图片/);
  assert.match(drawing, /name="seed"/);
  assert.match(drawing, /form="drawingGenerateForm"/);
  assert.doesNotMatch(drawing, /class="drawing-settings"/);
  assert.match(drawing, /class="reference-import-panel"/);
  assert.match(drawing, /class="reference-groups"/);
  assert.doesNotMatch(drawing, /reference-detail-empty/);
  assert.doesNotMatch(drawing, /不会自动发送或写入资料库/);
  assert.doesNotMatch(drawing, /出图引擎待迁入/);
});

test("drawing and audio subpages keep return navigation and real settings entrypoints without internal boundary copy", () => {
  assert.match(renderCreate(), /返回创作/);
  assert.match(renderCreate(), /为可复用的视觉灵感建立清晰的资料库/);
  const audio = renderVoiceDesign();
  assert.match(audio, /返回创作/);
  assert.match(audio, /音色设置/);
  assert.match(audio, /data-open-voice-settings/);
  assert.match(audio, /aria-label="音色设置"/);
  assert.match(audio, /<dialog id="voiceSettingsDialog" class="create-settings-dialog"/);
  assert.match(audio, /data-close-voice-settings/);
  assert.doesNotMatch(audio, /<dialog[^>]+id="voiceSettingsDialog"[^>]*\sopen(?:\s|>)/);
  assert.match(audio, /目标 TTS 模型/);
  assert.doesNotMatch(audio, /class="voice-config voice-settings"/);
  assert.match(audio, /候选历史/);
  assert.match(audio, /管理 → API/);
  assert.match(audio, /data-open-api-services/);
  assert.doesNotMatch(audio, /name="apiKey"/);
  assert.doesNotMatch(audio, /name="baseUrl"/);
  assert.doesNotMatch(audio, /不会自动/);
  assert.doesNotMatch(audio, /微信/);
});
