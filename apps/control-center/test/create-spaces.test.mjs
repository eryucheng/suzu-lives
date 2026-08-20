import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CREATE_SPACES } from "../src/features/create/overview.mjs";

test("create overview keeps the visual workbench as the only real creation subspace", () => {
  assert.deepEqual(
    CREATE_SPACES.map(({ id, title }) => ({ id, title })),
    [
      { id: "visual", title: "视觉工作台" },
    ],
  );
  assert.equal(CREATE_SPACES.length, 1);
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

test("voice message settings own voice management and contact assignment in the React page", async () => {
  const detail = await readFile(new URL("../src/react/capability-detail-page.jsx", import.meta.url), "utf8");
  assert.match(detail, /配置联系人音色/u);
  assert.match(detail, /新增音色/u);
  assert.match(detail, /音色 ID/u);
  assert.match(detail, /voiceDesign\?\.snapshot/u);
  assert.match(detail, /voiceDesign\?\.saveCustomAudio/u);
  assert.match(detail, /voiceDesign\?\.deleteCustomVoice/u);
  assert.match(detail, /voiceDesign\.saveContactVoice/u);
  assert.match(detail, /CreateStudioDialog/u);
  assert.doesNotMatch(detail, /api\.voiceDesign\.create/u);
  assert.doesNotMatch(detail, /api\.voiceDesign\.preview/u);
  assert.doesNotMatch(detail, /retainCandidate/u);
});
