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
