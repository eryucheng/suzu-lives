import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNamedApiConnectionService } from "../src/index.mjs";

const opaque = () => String.fromCharCode(120, 121, 122);
const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from("sealed:" + value),
  decryptString: (value) => value.toString("utf8").replace(/^sealed:/u, ""),
};
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-connections-")); }

test("named DashScope connections keep keys masked, retain an edited key, and bind the whole image generation group", async () => {
  const root = await temporary();
  const service = createNamedApiConnectionService({ dataRoot: root, safeStorage: protector });
  await assert.rejects(() => service.save({ name: "阿里百炼", type: "dashscope" }), /必须填写 API Key/u);
  const first = await service.save({ name: "阿里百炼", type: "dashscope", apiKey: opaque() });
  const connection = first.connections[0];
  assert.equal(connection.name, "阿里百炼");
  assert.equal(JSON.stringify(first).includes(opaque()), false);
  await service.bind("image-generation", connection.id);
  const resolved = await service.resolve("phone-camera");
  assert.equal(resolved.apiKey, opaque());
  assert.equal(resolved.type, "dashscope");
  await service.save({ id: connection.id, name: "百炼图像", type: "dashscope" });
  assert.equal((await service.resolve("image-workbench")).apiKey, opaque());
});

test("named API connection remarks are unique while a connection keeps its own editable remark", async () => {
  const root = await temporary();
  const service = createNamedApiConnectionService({ dataRoot: root, safeStorage: protector });
  const first = await service.save({ name: "我的百炼", type: "dashscope", apiKey: opaque() });
  const firstConnection = first.connections[0];
  assert.equal(firstConnection.name, "我的百炼");
  await assert.rejects(
    () => service.save({ name: "  我的百炼  ", type: "generic-api", apiKey: opaque() + "-other" }),
    /API 备注“我的百炼”已经存在/u,
  );
  await service.save({ id: firstConnection.id, name: "工作百炼" });
  const reused = await service.save({ name: "我的百炼", type: "generic-api", apiKey: opaque() + "-other" });
  assert.equal(reused.connections.find((connection) => connection.name === "我的百炼")?.type, "generic-api");
});

test("named connection bindings reject incompatible types", async () => {
  const root = await temporary();
  const service = createNamedApiConnectionService({ dataRoot: root, safeStorage: protector });
  const dash = await service.save({ name: "阿里百炼", type: "dashscope", apiKey: opaque() });
  assert.equal(dash.connections[0].baseUrl, "https://dashscope.aliyuncs.com/api/v1");
  const generic = await service.save({ name: "通用", type: "generic-api", apiKey: opaque() + "-generic" });
  assert.equal(generic.connections.find((item) => item.name === "通用").baseUrl, "");
  const openai = await service.save({
    name: "开放语音",
    type: "openai-compatible",
    apiKey: opaque() + "-openai",
    baseUrl: "https://tts.example.test/v1",
    model: "tts-1",
  });
  await service.bind("image-generation", dash.connections[0].id);
  assert.equal((await service.resolve("image-generation")).apiKey, opaque());
  await service.bind("image-generation", generic.connections.find((item) => item.name === "通用").id);
  assert.equal((await service.resolve("phone-camera")).type, "generic-api");
  await service.bind("image-generation", openai.connections.find((item) => item.name === "开放语音").id);
  assert.equal((await service.resolve("image-workbench")).type, "openai-compatible");
  await service.bind("realtime-asr", dash.connections[0].id);
  assert.equal((await service.snapshot()).bindings["realtime-asr"], dash.connections[0].id);
  await service.bind("voice-message", openai.connections.find((item) => item.name === "开放语音").id);
  assert.equal((await service.resolve("voice-message")).type, "openai-compatible");
  await service.bind("voice-message", generic.connections.find((item) => item.name === "通用").id);
  assert.equal((await service.resolve("voice-message")).type, "generic-api");
  await assert.rejects(() => service.bind("realtime-asr", openai.connections.find((item) => item.name === "开放语音").id), /不兼容/u);
  await service.bind("memory-embedding", dash.connections[0].id);
  assert.equal((await service.resolve("memory-embedding")).apiKey, opaque());
  await assert.rejects(() => service.bind("memory-processing", dash.connections[0].id), /不支持/u);
});

test("named connections surface an unreadable saved key without exposing it", async () => {
  const root = await temporary();
  const writer = createNamedApiConnectionService({ dataRoot: root, safeStorage: protector });
  const created = await writer.save({ name: "阿里百炼", type: "dashscope", apiKey: opaque() });
  const reader = createNamedApiConnectionService({
    dataRoot: root,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: protector.encryptString,
      decryptString: () => { throw new Error("cannot decrypt"); },
    },
  });
  await reader.bind("voice-message", created.connections[0].id);
  const snapshot = await reader.snapshot();
  const connection = snapshot.connections[0];
  assert.equal(connection.configured, false);
  assert.equal(connection.credentialStatus, "unreadable");
  const resolved = await reader.resolve("voice-message");
  assert.equal(resolved.key, "");
  assert.equal(resolved.credentialStatus, "unreadable");
  assert.equal(JSON.stringify({ snapshot, resolved }).includes(opaque()), false);
});
