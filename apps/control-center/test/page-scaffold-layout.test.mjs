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

function cssRule(styles, selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
  const end = styles.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated CSS rule: ${selector}`);
  return styles.slice(start, end + 1);
}

test("页面标题栏和页面内容区保持为两个独立层级", () => {
  const scaffold = source("src", "react", "page-scaffold.jsx");
  const styles = source("src", "react", "page-scaffold.css");
  const shell = source("src", "react", "app-shell.jsx");

  assert.match(scaffold, /className="page-layout"[\s\S]*?className=\{joinClassNames\("page-layout__frame", className\)\}[\s\S]*?className="page-titlebar"[\s\S]*?className=\{joinClassNames\("page-canvas"/u);
  assert.match(styles, /--page-canvas-inline-start:23px;/u);
  assert.match(styles, /--page-canvas-inline-end:var\(--space-sm\);/u);
  assert.match(styles, /--page-layout-max-inline-size:1480px;/u);
  assert.match(styles, /--page-titlebar-inline-start:var\(--page-canvas-inline-start\);/u);
  assert.match(styles, /\.page-titlebar\s*\{[\s\S]*?background:transparent;[\s\S]*?padding:var\(--page-titlebar-block-start\) var\(--page-titlebar-inline-end\) var\(--page-titlebar-to-canvas-gap\) var\(--page-titlebar-inline-start\);/u);
  assert.match(styles, /--page-titlebar-to-canvas-gap:0;/u);
  assert.match(styles, /--page-canvas-block-start:var\(--space-sm\)/u);
  assert.match(styles, /\.page-layout\s*\{[\s\S]*?flex-direction:column;[\s\S]*?overflow:auto;[\s\S]*?scrollbar-gutter:stable;/u);
  assert.match(styles, /\.page-layout__frame\s*\{[\s\S]*?max-width:var\(--page-layout-max-inline-size\);[\s\S]*?min-height:100%;[\s\S]*?height:100%;[\s\S]*?flex:1 0 auto;[\s\S]*?flex-direction:column;[\s\S]*?margin:0 auto;/u);
  assert.match(styles, /\.page-layout__frame--bounded\s*\{[\s\S]*?min-block-size:0;[\s\S]*?block-size:auto;[\s\S]*?max-block-size:var\(--page-layout-max-block-size\);[\s\S]*?flex:1 1 auto;/u);
  assert.match(styles, /\.page-layout__frame--bounded > \.page-canvas--fill\s*\{[\s\S]*?flex:1 1 auto;/u);
  assert.match(styles, /\.page-canvas\s*\{[\s\S]*?background:transparent;[\s\S]*?overflow:visible;[\s\S]*?padding:var\(--page-canvas-block-start\) var\(--page-canvas-inline-end\) var\(--page-canvas-block-end\) var\(--page-canvas-inline-start\);/u);
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

test("所有页面标题都继承同一套 PageHeader 尺寸与位置规则", () => {
  const headerStyles = readFileSync(resolve(ROOT, "..", "..", "packages", "design-system", "src", "components", "PageHeader", "PageHeader.module.css"), "utf8");
  const todayStyles = source("src", "react", "today-page.css");
  const todayPage = source("src", "react", "today-page.jsx");

  assert.match(headerStyles, /\.title\s*\{[\s\S]*?margin: 6px 0 0;[\s\S]*?font-size: 36px;/u);
  assert.match(headerStyles, /\.subtitle\s*\{[\s\S]*?margin: 8px 0 0;/u);
  assert.match(headerStyles, /\.header\s*\{[\s\S]*?width:100%;[\s\S]*?max-width:none;/u);
  assert.doesNotMatch(todayStyles, /today-page-header/u);
  assert.doesNotMatch(todayPage, /className="today-page-header"/u);
});

test("页面外框的最大宽度统一由 PageScaffold 管理", () => {
  for (const [file, selector] of [
    ["today-page.css", ".today-react-page"],
    ["settings-page.css", ".settings-react-page"],
    ["relationships-page.css", ".relationships-react-page"],
    ["relationship-settings-page.css", ".relationship-settings-react-page"],
    ["plans-page.css", ".plans-react-page"],
    ["conversation-compactor-page.css", ".conversation-compactor-react-page"],
    ["agent-journal-page.css", ".agent-journal-react-page"],
    ["capabilities-page.css", ".capabilities-react-page"],
    ["admin-page.css", ".admin-react-page"],
  ]) {
    const rule = cssRule(source("src", "react", file), selector);
    assert.doesNotMatch(rule, /(?:max-width|margin:0 auto|layout-max-width)/u, `${file} must not recenter its outer page frame`);
  }

  const unavailable = source("src", "react", "chat-first-unavailable-page.css");
  assert.match(cssRule(unavailable, ".chat-first-unavailable-page"), /width:100%;/u);
  assert.match(cssRule(unavailable, ".chat-first-unavailable-panel"), /width:min\(760px,100%\);[\s\S]*?margin:0 auto;/u);
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

test("页面内容宽度不驱动卡片的纵向尺寸", () => {
  for (const file of [
    "today-page.css",
    "settings-page.css",
    "api-connections-ui.css",
    "conversation-compactor-page.css",
    "relationship-settings-page.css",
    "admin-page.css",
    "agent-journal-page.css",
    "plans-page.css",
  ]) {
    const styles = source("src", "react", file);
    assert.doesNotMatch(styles, /cqw/u, file);
  }

  const todayStyles = source("src", "react", "today-page.css");
  assert.doesNotMatch(todayStyles, /font-size:[^;]*vw/u);
  assert.match(todayStyles, /\.today-cost-value\s*\{[\s\S]*?font-size:38px;/u);
});

test("页面级滚动条只在内容工作区悬停时出现在最右侧轨道", () => {
  const shellStyles = source("src", "react", "app-shell.css");
  const scaffoldStyles = source("src", "react", "page-scaffold.css");

  assert.match(shellStyles, /--shell-page-scrollbar-size:12px;/u);
  assert.match(scaffoldStyles, /\.page-layout\s*\{[\s\S]*?--page-scrollbar-thumb:rgba\(224,230,246,\.34\);[\s\S]*?overflow:auto;[\s\S]*?scrollbar-color:transparent transparent;[\s\S]*?scrollbar-gutter:stable;/u);
  assert.match(scaffoldStyles, /\.page-layout::-webkit-scrollbar\s*\{[\s\S]*?width:var\(--shell-page-scrollbar-size\);[\s\S]*?background:transparent;/u);
  assert.match(scaffoldStyles, /\.page-layout::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:transparent;/u);
  assert.match(scaffoldStyles, /:root\[data-theme="light"\] \.page-layout\s*\{[\s\S]*?--page-scrollbar-thumb:rgba\(99,109,139,\.25\);/u);
  assert.match(scaffoldStyles, /\.page-layout:hover\s*\{[\s\S]*?scrollbar-color:var\(--page-scrollbar-thumb\) transparent;/u);
  assert.match(scaffoldStyles, /\.page-layout:hover::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:var\(--page-scrollbar-thumb\);/u);
});

test("相处设定、压缩器和日记共用联系人工作台规格与收缩规则", () => {
  const workspaces = [
    ["relationship-settings-page.css", ".relationship-settings-react-page", ".relationship-settings-workspace", ".relationship-settings-contact-rail"],
    ["conversation-compactor-page.css", ".conversation-compactor-react-page", ".conversation-compactor-workspace", ".conversation-compactor-session-rail"],
    ["agent-journal-page.css", ".agent-journal-react-page", ".agent-journal-workspace", ".agent-journal-contact-rail"],
  ];

  for (const [file, pageSelector, workspaceSelector, railSelector] of workspaces) {
    const styles = source("src", "react", file);
    assert.match(cssRule(styles, pageSelector), /container-type:inline-size;/u, file + " needs a local width container");
    assert.match(cssRule(styles, workspaceSelector), /grid-template-columns:minmax\(210px,.3fr\) minmax\(0,1fr\);[\s\S]*?align-items:stretch;[\s\S]*?min-width:0;/u, file + " needs the shared desktop workspace grid");
    assert.match(styles, new RegExp("@container \\(max-width:1140px\\) \\{[\\s\\S]*?" + workspaceSelector.replaceAll(".", "\\.") + " \\{ grid-template-columns:minmax\\(0,1fr\\); min-height:0; \\}[\\s\\S]*?" + railSelector.replaceAll(".", "\\.") + " \\{ display:none; \\}", "u"), file + " must hide the rail instead of stacking it");
  }

  const compactor = source("src", "react", "conversation-compactor-page.jsx");
  const journal = source("src", "react", "agent-journal-page.jsx");
  assert.match(compactor, /<Roster[\s\S]*?avatar=\{<Avatar name=\{name\} size="md" \/>\}[\s\S]*?subtitle=\{selected \? "当前联系人" : "切换到此联系人"\}/u);
  assert.match(journal, /canvasClassName="page-canvas--fill"[\s\S]*?className="agent-journal-react-page"/u);
  assert.match(journal, /<div className="agent-journal-page-body">/u);
  assert.match(journal, /<Roster[\s\S]*?avatar=\{<Avatar name=\{name\} size="md" \/>\}[\s\S]*?subtitle=\{selected \? "当前联系人" : "切换到此联系人"\}/u);
});
