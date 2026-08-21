import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REACT = resolve(ROOT, "src", "react");

function source(...parts) {
  return readFileSync(resolve(ROOT, ...parts), "utf8");
}

test("页面标题栏和页面内容区保持为两个独立层级", () => {
  const scaffold = source("src", "react", "page-scaffold.jsx");
  const styles = source("src", "react", "page-scaffold.css");
  const shell = source("src", "react", "app-shell.jsx");

  assert.match(scaffold, /className="page-titlebar"[\s\S]*?className=\{joinClassNames\("page-canvas"/u);
  assert.match(styles, /\.page-titlebar\s*\{[\s\S]*?background:transparent;[\s\S]*?padding:var\(--page-titlebar-block-start\)/u);
  assert.match(styles, /--page-titlebar-to-canvas-gap:0;/u);
  assert.match(styles, /--page-canvas-block-start:var\(--space-sm\)/u);
  assert.match(styles, /\.page-layout\s*\{[\s\S]*?flex-direction:column;[\s\S]*?overflow:auto;[\s\S]*?scrollbar-gutter:stable;/u);
  assert.match(styles, /\.page-canvas\s*\{[\s\S]*?background:transparent;[\s\S]*?overflow:visible;[\s\S]*?padding:var\(--page-canvas-block-start\) var\(--page-canvas-inline\) var\(--page-canvas-block-end\)/u);
  assert.match(styles, /\.page-canvas--fill\s*\{[\s\S]*?flex:1 0 auto;/u);
  assert.match(styles, /\.page-canvas\s*\{[\s\S]*?--glass-panel-shadow:none;[\s\S]*?--glass-panel-prominent-shadow:none;/u);
  assert.match(styles, /\.page-canvas--stack\s*\{[\s\S]*?gap:var\(--page-card-gap\)/u);
  assert.match(shell, /content page-workspace/u);
});

test("普通页面都通过统一的页面内容区承接卡片布局", () => {
  for (const file of [
    "today-page.jsx",
    "relationships-page.jsx",
    "settings-page.jsx",
    "admin-page.jsx",
    "plans-page.jsx",
    "capabilities-page.jsx",
    "capability-detail-page.jsx",
    "agent-journal-page.jsx",
    "relationship-settings-page.jsx",
    "conversation-compactor-page.jsx",
    "memory-page.jsx",
    "create-page.jsx",
    "create-visual-page.jsx",
  ]) {
    const page = readFileSync(resolve(REACT, file), "utf8");
    assert.match(page, /PageScaffold/u, file);
  }
});

test("React 页面不再加载旧版 shell 样式", () => {
  const globalStyles = source("src", "styles.css");

  assert.doesNotMatch(globalStyles, /styles\/shell\.css/u);
});

test("创造页静止卡片不向 PageCanvas 的卡片间隙投射外扩阴影", () => {
  const scaffoldStyles = source("src", "react", "page-scaffold.css");
  const createStyles = source("src", "styles", "create.css");

  assert.match(scaffoldStyles, /--page-static-card-shadow:inset 0 1px rgba\(255,255,255,\.035\);/u);
  assert.match(createStyles, /\.create-space-card\s*\{[\s\S]*?box-shadow:var\(--page-static-card-shadow\);/u);
  assert.match(createStyles, /\.drawing-compose-panel,[\s\S]*?\.voice-history\s*\{[\s\S]*?box-shadow:var\(--page-static-card-shadow\);/u);
  assert.match(createStyles, /\.create-space-card:hover\s*\{[\s\S]*?box-shadow:\s*0 21px 50px/u);
});
