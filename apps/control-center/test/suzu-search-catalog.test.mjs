import assert from "node:assert/strict";
import test from "node:test";

import { getSuzuSearchItem, searchSuzuSearchItems } from "../src/core/suzu-search.mjs";

test("product destination catalog only lists app destinations, not user content", () => {
  const results = searchSuzuSearchItems("主题");
  assert.deepEqual(results.map((entry) => entry.id), ["appearance"]);
  assert.equal(results[0].target.view, "settings");
  assert.equal(results[0].target.settingsTab, "general");
});

test("product destination catalog finds settings through labels and aliases", () => {
  assert.equal(searchSuzuSearchItems("费用")[0]?.id, "usage");
  assert.equal(searchSuzuSearchItems("agent")[0]?.id, "main-model");
  assert.equal(searchSuzuSearchItems("接口")[0]?.id, "api-connections");
  assert.equal(searchSuzuSearchItems("聊天")[0]?.id, "conversation");
  assert.equal(searchSuzuSearchItems("不存在的功能").length, 0);
});

test("product destination catalog keeps active relationship tools and the restored creation entrance", () => {
  assert.equal(searchSuzuSearchItems("日历")[0]?.id, "today");
  assert.equal(searchSuzuSearchItems("压缩")[0]?.id, "conversation-compactor");
  assert.equal(searchSuzuSearchItems("微信").length, 0);
  assert.equal(searchSuzuSearchItems("图片生成")[0]?.id, "create");
  assert.equal(searchSuzuSearchItems("长期记忆")[0]?.id, "memory");
  assert.equal(searchSuzuSearchItems("计划")[0]?.id, "plans");
});

test("product destination catalog returns a bounded set of featured destinations before typing", () => {
  const results = searchSuzuSearchItems("");
  assert.ok(results.length > 0);
  assert.ok(results.every((entry) => entry.featured));
  assert.equal(getSuzuSearchItem("api-connections")?.target.settingsTab, "api");
  assert.equal(getSuzuSearchItem("system-status")?.target.settingsTab, "data");
  assert.equal(getSuzuSearchItem("missing"), null);
});
