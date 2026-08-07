import assert from "node:assert/strict";
import test from "node:test";

import { loadVisualReferences, renderCreate, renderVisualReferences } from "../src/features/create/index.mjs";

test("visual reference workspace keeps import and organization tools without generated-media placeholder copy", () => {
  const view = renderCreate();
  assert.match(view, /视觉参考库/);
  assert.match(view, /从本机选择图片/);
  assert.match(view, /补充视觉参考/);
  assert.match(view, /组织一组参考/);
  assert.doesNotMatch(view, /不会调用图片理解或生成模型/);
  assert.doesNotMatch(view, /创作能力准备中/);
});

test("embedded visual references select by thumbnail square instead of a description checklist", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { querySelectorAll: () => [] };
  try {
    await loadVisualReferences({
      api: { visualReferences: {
        snapshot: async () => ({ status: "ready", assets: [{ id: "portrait-a", role: "identity", description: "雨夜人像", sets: ["lead"] }], sets: [{ id: "lead", description: "主角", assets: ["portrait-a"] }] }),
        thumbnail: async () => "data:image/png;base64,fixture",
      } },
      render() {},
    });
    const view = renderVisualReferences({ embedded: true, selectedReferences: new Set(["portrait-a"]) });
    assert.match(view, /data-drawing-reference-toggle="portrait-a"/);
    assert.match(view, /reference-select-square selected/);
    assert.match(view, /aria-pressed="true"/);
    assert.match(view, /角色/);
    assert.match(view, /分组/);
    assert.doesNotMatch(view, /drawing-reference-picks/);
  } finally {
    globalThis.document = previousDocument;
  }
});
