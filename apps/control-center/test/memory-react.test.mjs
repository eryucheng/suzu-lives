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
  assert.match(app, /selectContact: loadMemoryScope/u);
  assert.match(app, /refreshStatus: refreshMemoryScope/u);
  assert.doesNotMatch(app, /bindMemoryEvents/u);
  assert.doesNotMatch(app, /renderMemory\(context\)/u);

  assert.match(page, /export function MemoryPage/u);
  assert.match(page, /useState/u);
  assert.match(page, /PageHeader/u);
  assert.match(page, /createMemoryBrainView/u);
  assert.match(page, /memory\.contacts/u);
  assert.match(page, /contactId \}/u);
  assert.match(page, /审核中心/u);
  assert.match(page, /const EMPTY_MEMORY_GRAPH/u);
  assert.match(page, /if \(!contactId \|\| !available\)[\s\S]*setGraph\(EMPTY_MEMORY_GRAPH\)/u);
  assert.match(page, /setView\("brain"\);/u);
  assert.match(page, /const visibleView = \["brain", "library", "review"\]\.includes\(view\) \? view : "brain";/u);
  assert.match(page, /<MemoryBrain api=\{api\} available=\{ready\}/u);
  assert.match(page, /记忆大脑<\/Button>\n    <Button[\s\S]*列表管理<\/Button>\n    <Button[\s\S]*审核中心<\/Button>/u);
  assert.match(page, /visibleView === "library"[\s\S]*disabled=\{!ready \|\| loading\}[\s\S]*列表管理/u);
  assert.doesNotMatch(page, /\{ready \? <>/u);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(page, /memory\.sessions/u);

  assert.ok(page.indexOf("memory-contact-picker-trigger") < page.indexOf("memory-recall-toggle"));
  assert.match(css, /#memoryReactRoot[\s\S]*min-width:\s*920px/u);
  assert.doesNotMatch(css, /@media/u);
});
