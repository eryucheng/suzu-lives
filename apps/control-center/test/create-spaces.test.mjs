import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CREATE_SPACES } from "../src/features/create/overview.mjs";

test("create overview exposes visual workbench and voice design as separate real subspaces", () => {
  assert.deepEqual(
    CREATE_SPACES.map(({ id, title }) => ({ id, title })),
    [
      { id: "visual", title: "视觉工作台" },
      { id: "audio", title: "音色设计" },
    ],
  );
  assert.equal(CREATE_SPACES.length, 2);
  assert.ok(CREATE_SPACES.every((space) => space.label === "进入创作" && space.detail));
  assert.ok(CREATE_SPACES.every((space) => !space.title.includes("视频")));
});

test("visual workbench keeps its real image and visual-reference flows in the React page", async () => {
  const visual = await readFile(new URL("../src/react/create-visual-page.jsx", import.meta.url), "utf8");
  assert.match(visual, /PageHeader/u);
  assert.match(visual, /绘画提示词/u);
  assert.match(visual, /本次参考/u);
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

test("voice design keeps local playback, candidate management, and contact assignment in the React page", async () => {
  const audio = await readFile(new URL("../src/react/create-audio-page.jsx", import.meta.url), "utf8");
  assert.match(audio, /PageHeader/u);
  assert.match(audio, /密钥需要重存/u);
  assert.match(audio, /重新保存阿里百炼 Key/u);
  assert.match(audio, /配置联系人音色/u);
  assert.match(audio, /修改音色名称/u);
  assert.match(audio, /new Audio\(objectUrl\)/u);
  assert.match(audio, /api\.voiceDesign\.create/u);
  assert.match(audio, /api\.voiceDesign\.preview/u);
  assert.match(audio, /api\.voiceDesign\.retainCandidate/u);
  assert.match(audio, /api\.voiceDesign\.renameCandidate/u);
  assert.match(audio, /api\.voiceDesign\.deleteCandidate/u);
  assert.match(audio, /api\.voiceDesign\.saveContactVoice/u);
  assert.match(audio, /api\.voiceDesign\.saveCustomAudio/u);
  assert.match(audio, /CreateStudioDialog/u);
  assert.doesNotMatch(audio, /renderVoiceDesign/u);
  assert.doesNotMatch(audio, /bindVoiceDesignEvents/u);
});
