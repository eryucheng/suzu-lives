import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableAgentId } from "@suzu-lives/agent-registry";
import { createConnectionsService } from "../electron/ipc/connections-ipc.mjs";

const opaque = () => String.fromCharCode(109, 105, 103, 114, 97, 116, 101, 100, 45, 107, 101, 121);
const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`),
  decryptString: (value) => value.toString("utf8").replace(/^sealed:/u, ""),
};

test("create and audio snapshots report a selected named connection without legacy fixed files", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-selected-connections-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-selected-connections-project-"));
  const settings = { projectRoot, dataRoot, agentId: stableAgentId(projectRoot) };
  const service = createConnectionsService({ safeStorage: protector, settingsService: { load: () => settings, response: () => ({ dataRoot }) } });
  const dashscope = await service.saveNamedApiConnection({ name: "阿里百炼", type: "dashscope", baseUrl: "https://dashscope.example.test/v1", apiKey: opaque() + "-voice" });
  const dashscopeId = dashscope.connections.find((item) => item.name === "阿里百炼").id;
  await service.bindNamedApiConnection("image-generation", dashscopeId);
  await service.bindNamedApiConnection("voice-design", dashscopeId);
  const imageSnapshot = await service.imageApiSnapshot();
  const voiceSnapshot = await service.dashScopeSnapshot();
  assert.equal(imageSnapshot.configured, true);
  assert.equal(imageSnapshot.textToImageModel, "z-image-turbo");
  assert.equal(imageSnapshot.referenceImageModel, "wan2.7-image");
  assert.equal(voiceSnapshot.configured, true);
  assert.equal(voiceSnapshot.baseUrl, "https://dashscope.example.test/v1");
  assert.equal(JSON.stringify({ imageSnapshot, voiceSnapshot }).includes(opaque()), false);
});

test("environment API keys stay runtime-only and are never copied into named connections", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-environment-connections-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-environment-connections-project-"));
  const settings = { projectRoot, dataRoot, agentId: stableAgentId(projectRoot) };
  const environment = {
    DASHSCOPE_API_KEY: "environment-dashscope-key",
    VISION_API_KEY: "environment-vision-key",
    VIDEO_UNDERSTANDING_API_KEY: "environment-video-key",
  };
  const service = createConnectionsService({ safeStorage: protector, settingsService: { load: () => settings, response: () => ({ dataRoot }) }, environment });
  const snapshot = await service.apiServicesSnapshot();
  assert.equal(snapshot.connections.length, 0);
  const namedStore = await fs.readFile(path.join(dataRoot, "connections", "api-connections.json"), "utf8").catch((error) => {
    if (error && error.code === "ENOENT") return "";
    throw error;
  });
  assert.doesNotMatch(namedStore, /environment-(dashscope|vision|video)-key/u);
  assert.equal((await service.resolveImageApi()).source, "environment");
  assert.equal((await service.resolveDashScope()).source, "environment");
});
