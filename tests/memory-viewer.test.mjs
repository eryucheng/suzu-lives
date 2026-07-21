import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(HERE, "..", "tools", "memory-viewer", "server.mjs");
const { searchMemoryStores, startServer } = await import(pathToFileURL(SERVER_PATH));

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "suzu-memory-viewer-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.jsonl");
  const eventsPath = path.join(directory, "events.jsonl");
  await fsp.writeFile(
    historyPath,
    `${JSON.stringify({ timestamp: "2026-07-01T10:00:00+08:00", role: "user", text: "我去了科技馆" })}\n`,
    "utf8",
  );
  await fsp.writeFile(
    eventsPath,
    `${JSON.stringify({ event_date: "2026-07-01", title: "科技馆", text: "用户参观了科技馆" })}\n`,
    "utf8",
  );
  return {
    historyPath,
    eventsPath,
    embedding: { enabled: false, model: "" },
  };
}

test("纯搜索同时覆盖原始对话与事件", async (t) => {
  const config = await fixture(t);
  const result = searchMemoryStores(config, "科技馆", "all", 10);
  assert.equal(result.matchedRecords, 2);
  assert.deepEqual(result.matches.map((item) => item.source).sort(), ["events", "history"]);
});

test("网页服务仅绑定本机，时间查询按真实 Hook 规则跳过召回", async (t) => {
  const config = await fixture(t);
  const { server } = await startServer({ port: 0, config });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, "127.0.0.1");

  const statusResponse = await fetch(`http://127.0.0.1:${address.port}/api/status`);
  const status = await statusResponse.json();
  assert.equal(status.historyRecords, 1);
  assert.equal(status.eventRecords, 1);

  const recallResponse = await fetch(`http://127.0.0.1:${address.port}/api/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "现在几点了" }),
  });
  const recall = await recallResponse.json();
  assert.equal(recallResponse.status, 200);
  assert.equal(recall.context, "");
  assert.match(recall.skippedReason, /^hook-/u);
});
