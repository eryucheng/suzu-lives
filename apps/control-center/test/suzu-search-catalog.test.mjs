import assert from "node:assert/strict";
import test from "node:test";

import { getSuzuSearchItem, searchSuzuSearchItems } from "../src/core/suzu-search.mjs";

test("Suzu Search only catalogs app destinations, not user content", () => {
  const results = searchSuzuSearchItems("主题");
  assert.deepEqual(results.map((entry) => entry.id), ["appearance"]);
  assert.equal(results[0].target.view, "settings");
  assert.equal(results[0].target.settingsTab, "general");
});

test("Suzu Search finds settings through labels and aliases", () => {
  assert.equal(searchSuzuSearchItems("微信")[0]?.id, "wechat");
  assert.equal(searchSuzuSearchItems("费用")[0]?.id, "usage");
  assert.equal(searchSuzuSearchItems("claude")[0]?.id, "claude-code");
  assert.equal(searchSuzuSearchItems("审批模式")[0]?.id, "conversation");
  assert.equal(searchSuzuSearchItems("不存在的功能").length, 0);
});

test("Suzu Search returns a bounded set of featured destinations before typing", () => {
  const results = searchSuzuSearchItems("");
  assert.ok(results.length > 0);
  assert.ok(results.every((entry) => entry.featured));
  assert.equal(getSuzuSearchItem("system-status")?.target.settingsTab, "data");
  assert.equal(getSuzuSearchItem("missing"), null);
});
