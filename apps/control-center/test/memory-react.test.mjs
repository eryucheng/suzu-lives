import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

function source(...parts) {
  return readFile(resolve(APP_ROOT, ...parts), "utf8");
}

test("memory route is owned by a React page and scopes every action to a contact", async () => {
  const [router, app, page, css] = await Promise.all([
    source("src", "react", "app-router.jsx"),
    source("src", "app.mjs"),
    source("src", "react", "memory-page.jsx"),
    source("src", "react", "memory-page.css"),
  ]);

  assert.match(router, /import \{ MemoryPage \}/u);
  assert.match(router, /id="memoryReactRoot"/u);
  assert.match(router, /<MemoryPage \{\.\.\.props\} \/>/u);
  assert.doesNotMatch(router, /LegacyMarkup/u);

  assert.match(app, /kind: "memory"/u);
  assert.match(app, /state\.view === "relationships" && state\.relationshipPage === "memory" \? "content--memory"/u);
  assert.match(app, /selectContact: loadMemoryScope/u);
  assert.match(app, /refreshStatus: refreshMemoryScope/u);
  assert.doesNotMatch(app, /bindMemoryEvents/u);
  assert.doesNotMatch(app, /renderMemory\(context\)/u);

  assert.match(page, /export function MemoryPage/u);
  assert.match(page, /useState/u);
  assert.match(page, /PageHeader/u);
  assert.match(page, /PageScaffold/u);
  assert.match(page, /createMemoryBrainView/u);
  assert.match(page, /memory\.contacts/u);
  assert.match(page, /contactId \}/u);
  assert.match(page, /审核中心/u);
  assert.match(page, /查看并审核/u);
  assert.match(page, /接受并写入/u);
  assert.match(page, /该审核项已处理，当前仅可查看审计记录。/u);
  assert.match(page, /const EMPTY_MEMORY_GRAPH/u);
  assert.match(page, /if \(!contactId \|\| !available\)[\s\S]*setGraph\(EMPTY_MEMORY_GRAPH\)/u);
  assert.match(page, /setView\("brain"\);/u);
  assert.match(page, /const visibleView = \["brain", "library", "review"\]\.includes\(view\) \? view : "brain";/u);
  assert.match(page, /<MemoryBrain api=\{api\} available=\{ready\}/u);
  assert.match(page, /Switch, Tabs/u);
  assert.match(page, /<Switch[^>]*checked=\{recallEnabled\}/u);
  assert.match(page, /<Tabs active=\{visibleView\}[^>]*items=\{MEMORY_VIEW_TABS\}[^>]*onChange=\{selectView\}/u);
  assert.match(page, /\{ label: "记忆大脑", value: "brain" \}/u);
  assert.match(page, /selectImportDatabase/u);
  assert.match(page, /inspectImportDatabase/u);
  assert.match(page, /importDatabase/u);
  assert.match(page, /导入记忆/u);
  assert.match(page, /导入 Suzu Memory 记忆/u);
  assert.match(page, /请选择由 Suzu Memory 创建的/u);
  assert.match(page, /选择 \.db 文件/u);
  assert.match(page, /if \(loading \|\| \(!ready && nextView !== "brain"\)\) return;/u);
  assert.match(page, /<div className="memory-library-actions">[\s\S]*修改[\s\S]*删除/u);
  assert.doesNotMatch(page, /editingEnabled|编辑记忆|完成编辑/u);
  assert.match(page, /自动整理模型：/u);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(page, /memory\.sessions/u);

  assert.ok(page.indexOf("memory-contact-picker-trigger") < page.indexOf("memory-recall-control"));
  assert.match(css, /#memoryReactRoot[\s\S]*min-width:\s*0;/u);
  assert.doesNotMatch(css, /#content\.content--memory/u);
  assert.doesNotMatch(css, /@media/u);
});
