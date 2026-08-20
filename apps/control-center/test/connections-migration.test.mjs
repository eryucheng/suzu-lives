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
  const dashscope = await service.saveNamedApiConnection({ name: "阿里百炼", type: "dashscope", baseUrl: "https://dashscope.example.test/v1", apiKey: opaque() + "-voice", model: "wan2.7-image" });
  const dashscopeId = dashscope.connections.find((item) => item.name === "阿里百炼").id;
  await service.bindNamedApiConnection("image-generation", dashscopeId);
  await service.bindNamedApiConnection("voice-message", dashscopeId);
  const imageSnapshot = await service.imageApiSnapshot();
  const services = await service.apiServicesSnapshot();
  assert.equal(imageSnapshot.configured, true);
  assert.equal(imageSnapshot.textToImageModel, "wan2.7-image");
  assert.equal(imageSnapshot.referenceImageModel, "wan2.7-image");
  assert.equal(services.bindings["voice-message"], dashscopeId);
  assert.equal(JSON.stringify({ imageSnapshot, services }).includes(opaque()), false);
  await assert.rejects(fs.stat(path.join(dataRoot, "connections", "dashscope.json")), /ENOENT/u);
});

test("legacy environment keys never become an implicit API connection", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-environment-connections-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-environment-connections-project-"));
  const settings = { projectRoot, dataRoot, agentId: stableAgentId(projectRoot) };
  const environment = {
    DASHSCOPE_API_KEY: "environment-dashscope-key",
    VISION_API_KEY: "environment-vision-key",
    VIDEO_UNDERSTANDING_API_KEY: "environment-video-key",
  };
  const service = createConnectionsService({ safeStorage: protector, settingsService: { load: () => settings, response: () => ({ dataRoot }) } });
  const snapshot = await service.apiServicesSnapshot();
  assert.equal(snapshot.connections.length, 0);
  const namedStore = await fs.readFile(path.join(dataRoot, "connections", "api-connections.json"), "utf8").catch((error) => {
    if (error && error.code === "ENOENT") return "";
    throw error;
  });
  assert.doesNotMatch(namedStore, /environment-(dashscope|vision|video)-key/u);
  assert.equal(await service.resolveImageApi(), null);
  assert.equal(await service.resolveNamedApiConnection("voice-message"), null);
});
