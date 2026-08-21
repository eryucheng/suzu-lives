import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SUZU_ADMIN_TABS,
  getDeferredCapabilityView,
  normalizeSuzuNavigationView,
  resolveSuzuRelationshipPage,
} from "../src/core/chat-first.mjs";

test("the software shell keeps core navigation while deferring only capability views", async () => {
  const source = await readFile(new URL("../src/react/app-shell.jsx", import.meta.url), "utf8");
  const application = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  for (const entry of [
    'view: "today", label: "今天", icon: "spark"',
    'view: "conversation", label: "对话", icon: "chat"',
    'view: "relationships", label: "关系", icon: "people"',
    'view: "capabilities", label: "能力", icon: "sliders"',
    'view: "plans", label: "计划", icon: "calendar"',
    'view: "create", label: "创造", icon: "palette"',
    'view: "admin", label: "管理", icon: "sliders"',
    'view: "settings", label: "设置", icon: "gear"',
  ]) assert.match(source, new RegExp(entry, "u"));
  assert.match(source, /view: "today"[\s\S]*?view: "conversation"[\s\S]*?view: "relationships"[\s\S]*?view: "capabilities"[\s\S]*?view: "plans"[\s\S]*?view: "create"/u);
  assert.match(source, /view === "conversation"[\s\S]*?openSuzuSearchItem\?\.\("conversation"\)/u);
  assert.match(source, /route\?\.kind === "conversation"[\s\S]*?\? "conversation"/u);
  assert.match(source, /item\.view === "conversation" && conversationUnread/u);
  assert.doesNotMatch(source, /label: "聊天"|label: "相处设定"|label: "模型"/u);
  assert.match(application, /if \(nextView === "today"\) void refreshTodayCalendar\(\);/u);
  assert.match(application, /if \(nextView === "today"\) void loadUsageLedger\(\);/u);
  assert.match(application, /if \(nextView === "plans"\) void loadSchedules\(\);/u);
  assert.match(application, /if \(nextPage === "overview"\) void loadMemoryScope\(\);/u);
  assert.match(application, /if \(nextPage === "memory"\) void loadMemoryScope\(\);/u);
  assert.deepEqual(SUZU_ADMIN_TABS, ["agent", "usage"]);
});

test("top-level page headers use their corresponding navigation labels", async () => {
  const relationships = await readFile(new URL("../src/react/relationships-page.jsx", import.meta.url), "utf8");
  const plans = await readFile(new URL("../src/react/plans-page.jsx", import.meta.url), "utf8");
  const create = await readFile(new URL("../src/react/create-page.jsx", import.meta.url), "utf8");

  assert.match(relationships, /title="关系"/u);
  assert.doesNotMatch(relationships, /title="让关系有连续的记忆"/u);
  assert.match(plans, /title="计划"/u);
  assert.doesNotMatch(plans, /title="计划，不只是待办列表"/u);
  assert.match(create, /title="创造"/u);
  assert.doesNotMatch(create, /title="创作"/u);
});

test("relationship navigation keeps the original overview before its editor", () => {
  assert.equal(normalizeSuzuNavigationView("relationships"), "relationships");
  assert.equal(getDeferredCapabilityView("today"), null);
  assert.equal(getDeferredCapabilityView("plans"), null);
  assert.equal(getDeferredCapabilityView("create"), null);
  assert.equal(getDeferredCapabilityView("settings"), null);
});

test("relationship overview keeps active memory and settings cards", () => {
  assert.deepEqual(resolveSuzuRelationshipPage("overview"), { page: "overview", unavailable: null });
  assert.deepEqual(resolveSuzuRelationshipPage("compactor"), { page: "compactor", unavailable: null });
  assert.deepEqual(resolveSuzuRelationshipPage("settings"), { page: "settings", unavailable: null });
  assert.deepEqual(resolveSuzuRelationshipPage("memory"), { page: "memory", unavailable: null });
});
