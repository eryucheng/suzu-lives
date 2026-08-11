import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("visual reference workspace keeps import, organization, and thumbnail selection in React", async () => {
  const view = await readFile(new URL("../src/react/create-visual-page.jsx", import.meta.url), "utf8");
  assert.match(view, /从本机选择图片/u);
  assert.match(view, /补充视觉参考/u);
  assert.match(view, /组织一组参考/u);
  assert.match(view, /aria-pressed/u);
  assert.match(view, /角色/u);
  assert.match(view, /分组/u);
  assert.match(view, /api\.visualReferences\.thumbnail/u);
  assert.doesNotMatch(view, /drawing-reference-picks/u);
  assert.doesNotMatch(view, /创作能力准备中/u);
});
