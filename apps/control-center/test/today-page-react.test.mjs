import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("recurring calendar dates add only their year before marking the matching day", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "today-page.jsx"), "utf8");

  assert.match(page, /const key = String\(event\.date \|\| ""\)\.length === 5 \? `\$\{year\}-\$\{event\.date\}` : String\(event\.date \|\| ""\);/u);
  assert.doesNotMatch(page, /`\$\{prefix\}\$\{event\.date\}`/u);
});

test("today keeps its shortcut for the Agent journal instead of duplicating the sidebar chat entry", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "today-page.jsx"), "utf8");
  const application = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /aria-label="打开日记"[\s\S]*?actions\.openJournal/u);
  assert.match(page, /AGENT JOURNAL[\s\S]*?日记/u);
  assert.doesNotMatch(page, /actions\.openConversation/u);
  assert.match(application, /function openTodayJournal\(\)[\s\S]*?setRelationshipPage\("journal"\);/u);
  assert.match(application, /openJournal: openTodayJournal/u);
});

test("today is the startup page and refreshes its own snapshots", () => {
  const state = readFileSync(resolve(ROOT, "src", "core", "state.mjs"), "utf8");
  const application = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(state, /view: "today"/u);
  assert.match(state, /relationshipPage: "overview"/u);
  assert.match(application, /if \(state\.view === "today"\) \{\s*void refreshTodayCalendar\(\);\s*void loadUsageLedger\(\);\s*\}/u);
});

test("today calendar fills its growing panel while sharing the day panel's horizontal inset", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "today-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "today-page.css"), "utf8");

  assert.match(page, /layout="fill"/u);
  assert.match(page, /className="today-calendar"[\s\S]*?layout="fill"/u);
  assert.match(styles, /\.today-react-page\s*\{[\s\S]*?--today-panel-inline:var\(--space-lg\);/u);
  assert.match(styles, /\.today-calendar-panel\s*\{[\s\S]*?height:auto;[\s\S]*?align-self:stretch;[\s\S]*?padding:var\(--space-lg\) var\(--today-panel-inline\) var\(--space-sm\);/u);
  assert.match(styles, /\.today-calendar\.today-calendar\s*\{[\s\S]*?--calendar-fill-row-min-height:33px;/u);
  assert.match(styles, /\.today-day-panel\s*\{[\s\S]*?padding:var\(--space-lg\) var\(--today-panel-inline\);/u);
});

test("today's two upper columns grow together inside the vertical dashboard grid", () => {
  const styles = readFileSync(resolve(ROOT, "src", "react", "today-page.css"), "utf8");

  assert.match(styles, /\.today-glass-workspace\s*\{[\s\S]*?height:auto;[\s\S]*?align-self:stretch;[\s\S]*?grid-template-rows:auto;[\s\S]*?align-items:stretch;/u);
  assert.match(styles, /\.today-side-stack\s*\{[\s\S]*?height:auto;[\s\S]*?grid-template-rows:minmax\(0,2fr\) minmax\(92px,1fr\);/u);
  assert.match(styles, /\.today-calendar-panel\s*\{[\s\S]*?align-self:stretch;/u);
});

test("today grows by height until its design reference boundary, then leaves page background below", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "today-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "today-page.css"), "utf8");

  assert.match(page, /className="today-react-page page-layout__frame--bounded"/u);
  assert.match(styles, /\.today-react-page\s*\{[\s\S]*?--today-layout-max-block-size:calc\(920px - var\(--shell-topbar-height,40px\) - var\(--shell-bottombar-height,8px\)\);[\s\S]*?--page-layout-max-block-size:var\(--today-layout-max-block-size\);/u);
  assert.match(styles, /\.today-react-page\s*\{[\s\S]*?--today-workspace-min-block-size:328px;[\s\S]*?--today-insight-height:168px;/u);
  assert.match(styles, /\.today-page-content\s*\{[\s\S]*?grid-template-rows:minmax\(var\(--today-workspace-min-block-size\),2fr\) minmax\(var\(--today-insight-height\),1fr\);[\s\S]*?align-content:stretch;/u);
  assert.match(styles, /\.today-react-page\s*\{[\s\S]*?--today-insight-height:168px;/u);
  assert.match(styles, /\.today-insight-grid\s*\{[\s\S]*?min-block-size:var\(--today-insight-height\);[\s\S]*?height:auto;/u);
});

test("today overview cards are compact full-card links without duplicate text actions", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "today-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "today-page.css"), "utf8");

  assert.match(page, /recentEvents = Array\.isArray\(snapshot\.data\?\.events\) \? snapshot\.data\.events\.slice\(-2\)\.reverse\(\) : \[\]/u);
  assert.match(page, /className="today-cost-card__action"[\s\S]*?aria-label="打开用量记录"[\s\S]*?onClick=\{\(\) => actions\.openUsage\?\.\(\)\}/u);
  assert.match(page, /className="today-activity-card__action"[\s\S]*?onClick=\{\(\) => actions\.openUsage\?\.\(\)\}/u);
  assert.doesNotMatch(page, />查看用量</u);
  assert.doesNotMatch(page, />全部记录</u);
  assert.match(styles, /\.today-cost-card__action,\s*\.today-activity-card__action\s*\{/u);
  assert.match(styles, /\.today-activity-card\s*\{[\s\S]*?overflow:hidden;[\s\S]*?padding:0;/u);
});
