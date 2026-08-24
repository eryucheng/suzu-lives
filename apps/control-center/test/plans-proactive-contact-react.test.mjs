import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("计划页把主动关心作为联系人同步设置，而不是普通可删除计划", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "plans-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "plans-page.css"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");
  const ipc = readFileSync(resolve(ROOT, "electron", "ipc", "index.mjs"), "utf8");

  assert.match(page, /function ProactiveContactPlans/u);
  assert.match(page, /由 Suzu 决定下次检查时间；这里与联系人设置使用同一组开关。/u);
  assert.match(page, /actions\.setAutoMaintain/u);
  assert.match(page, /actions\.setContactEnabled/u);
  assert.match(page, /regularTasks = tasks\.filter\(\(task\) => !isProactiveContactTask\(task\)\)/u);
  assert.match(page, /下次判断：/u);
  assert.match(styles, /\.plans-proactive\s*\{/u);
  assert.match(styles, /\.plans-proactive__contact\s*\{/u);
  assert.match(app, /setProactiveContactAutoMaintain: setPlannedProactiveContactAutoMaintain/u);
  assert.match(app, /setProactiveContactEnabled: setPlannedProactiveContactEnabled/u);
  assert.match(app, /api\.capabilities\.saveSettings\("proactive-contact", value\)/u);
  assert.match(ipc, /systemKind: "proactive-contact"/u);
  assert.match(ipc, /proactiveContact: \{/u);
});
