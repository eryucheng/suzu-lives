import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_SERVER = path.join(HERE, "..", "tools", "session-viewer", "server.mjs");
const SERVER_PATH = fs.existsSync(REPOSITORY_SERVER)
  ? REPOSITORY_SERVER
  : path.join(HERE, "session-viewer", "server.mjs");
const { JsonlTail, startServer } = await import(pathToFileURL(SERVER_PATH));

function record(type, uuid, content) {
  return JSON.stringify({
    type,
    uuid,
    timestamp: "2026-07-17T10:00:00.000Z",
    message: { role: type, content },
  });
}

test("会话文件追加时只增加新记录，重写后自动重建", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "suzu-session-viewer-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "session.jsonl");
  await fsp.writeFile(transcript, `${record("user", "u1", "第一条")}\n`, "utf8");

  const tail = new JsonlTail(transcript, 100);
  await tail.refresh();
  assert.equal(tail.records.length, 1);

  await fsp.appendFile(transcript, `${record("assistant", "a1", [{ type: "text", text: "第二条" }])}\n`, "utf8");
  await tail.refresh();
  assert.equal(tail.records.length, 2);

  await fsp.writeFile(transcript, `${record("user", "u2", "重写后的记录")}\n`, "utf8");
  await tail.refresh();
  assert.equal(tail.records.length, 1);
  assert.equal(tail.records[0].uuid, "u2");
});

test("增量读取跨越 UTF-8 多字节字符时不会产生乱码", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "suzu-session-utf8-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "session.jsonl");
  const source = Buffer.from(`${record("user", "u1", "中文不会乱码")}\n`, "utf8");
  const chineseStart = source.indexOf(Buffer.from("中", "utf8"));
  const splitAt = chineseStart + 1;

  await fsp.writeFile(transcript, source.subarray(0, splitAt));
  const tail = new JsonlTail(transcript, 100);
  await tail.refresh();
  assert.equal(tail.records.length, 0);

  await fsp.appendFile(transcript, source.subarray(splitAt));
  await tail.refresh();
  assert.equal(tail.records.length, 1);
  assert.equal(tail.records[0].message.content, "中文不会乱码");
  assert.equal(tail.malformedLines, 0);
});

test("网页服务仅绑定本机且不暴露配置文件", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "suzu-session-server-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "session.jsonl");
  await fsp.writeFile(transcript, `${record("user", "u1", "测试消息")}\n`, "utf8");

  const options = {
    sessionFilePath: transcript,
    port: 0,
    pollIntervalMs: 2000,
    maxMessages: 100,
    maxRecords: 500,
  };
  const { server } = await startServer(options);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, "127.0.0.1");

  const api = await fetch(`http://127.0.0.1:${address.port}/api/session`);
  const payload = await api.json();
  assert.equal(api.status, 200);
  assert.equal(payload.fileName, "session.jsonl");
  assert.equal(payload.records.length, 1);
  assert.equal(JSON.stringify(payload).includes(directory), false);

  const config = await fetch(`http://127.0.0.1:${address.port}/config.local.json`);
  assert.equal(config.status, 404);
});
