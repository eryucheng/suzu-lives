import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashScopeConnectionService, createNamedApiConnectionService } from "../src/index.mjs";

const opaque = () => String.fromCharCode(120, 121, 122);
const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from("sealed:" + value),
  decryptString: (value) => value.toString("utf8").replace(/^sealed:/u, ""),
};
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-connections-")); }

test("connection snapshots stay masked and environment credentials win", async () => {
  const root = await temporary();
  const service = createDashScopeConnectionService({ dataRoot: root, safeStorage: protector, environment: {} });
  await service.save({ apiKey: opaque(), baseUrl: "https://example.test/api/v1/" });
  const saved = await service.snapshot();
  assert.deepEqual(saved, { baseUrl: "https://example.test/api/v1", configured: true, source: "saved" });
  assert.equal(JSON.stringify(saved).includes(opaque()), false);
  const environment = { DASHSCOPE_API_KEY: opaque() + "e" };
  const withEnvironment = createDashScopeConnectionService({ dataRoot: root, safeStorage: protector, environment });
  assert.equal((await withEnvironment.snapshot()).source, "environment");
  assert.equal((await withEnvironment.resolve()).source, "environment");
  await withEnvironment.clear();
  assert.equal((await withEnvironment.snapshot()).source, "environment");
});

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

test("named connection bindings reject incompatible types", async () => {
  const root = await temporary();
  const service = createNamedApiConnectionService({ dataRoot: root, safeStorage: protector });
  const dash = await service.save({ name: "阿里百炼", type: "dashscope", apiKey: opaque() });
  assert.equal(dash.connections[0].baseUrl, "https://dashscope.aliyuncs.com/api/v1");
  const generic = await service.save({ name: "通用", type: "generic-api", apiKey: opaque() + "-generic" });
  assert.equal(generic.connections.find((item) => item.name === "通用").baseUrl, "");
  await service.bind("image-generation", dash.connections[0].id);
  assert.equal((await service.resolve("image-generation")).apiKey, opaque());
  await assert.rejects(() => service.bind("image-generation", generic.connections.find((item) => item.name === "通用").id), /不兼容/u);
  await service.bind("sound", dash.connections[0].id);
  assert.equal((await service.snapshot()).bindings["voice-design"], dash.connections[0].id);
  assert.equal((await service.snapshot()).bindings["voice-message"], dash.connections[0].id);
  await service.bind("memory-embedding", dash.connections[0].id);
  assert.equal((await service.resolve("memory-embedding")).apiKey, opaque());
  await assert.rejects(() => service.bind("memory-processing", dash.connections[0].id), /不支持/u);
});
