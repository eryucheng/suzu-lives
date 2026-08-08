import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { createVoiceCandidates, retainVoiceCandidate } from "@suzu-lives/voice-design";

import { registerVoiceDesignIpc } from "../electron/ipc/voice-design-ipc.mjs";

const voiceConfig = {
  baseUrl: "https://example.test/api/v1",
  designModel: "qwen-voice-design",
  targetModel: "qwen3-tts-vd-2026-01-26",
  namePrefix: "suzu",
  language: "zh",
  sampleRate: 24000,
  responseFormat: "wav",
};

test("voice design deletion keeps the current contact from losing its configured candidate", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-ipc-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-ipc-project-"));
  const settings = { agentId: "agent-voice-delete", projectRoot };
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId });
  const root = path.join(agentRoot, "voice-design");
  const [candidate] = await createVoiceCandidates({
    root,
    config: voiceConfig,
    input: { voicePrompt: "温和自然", previewText: "你好，这是试听。", count: 1 },
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ output: { voice: "voice-current", preview_audio: { data: Buffer.from("preview").toString("base64") } } }) }),
  });
  const contactConfigPath = path.join(agentRoot, "voice-message", "config.json");
  await fs.mkdir(path.dirname(contactConfigPath), { recursive: true });
  await fs.writeFile(contactConfigPath, JSON.stringify({ voiceId: candidate.voiceId }), "utf8");

  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot }),
      usageLedgerPath: () => path.join(dataRoot, "cost-ledger", "events.jsonl"),
    },
    connectionsService: { dashScopeSnapshot: async () => ({ configured: true, credentialStatus: "ready" }) },
  });

  const remove = handlers.get("voice-design:delete-candidate");
  await assert.rejects(remove(null, candidate.id), /正在被联系人使用/u);

  await fs.writeFile(contactConfigPath, JSON.stringify({ voiceId: "voice-other" }), "utf8");
  const snapshot = await remove(null, candidate.id);
  assert.deepEqual(snapshot.candidates, []);
});

test("custom audio keeps provider keys locally while exposing MiniMax and Alibaba cloning choices without keys", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-custom-audio-ipc-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-custom-audio-ipc-project-"));
  const settings = { agentId: "agent-custom-audio", projectRoot };
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId });
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot }),
      usageLedgerPath: () => path.join(dataRoot, "cost-ledger", "events.jsonl"),
    },
    connectionsService: { dashScopeSnapshot: async () => ({ configured: true, credentialStatus: "ready" }) },
  });

  const snapshot = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "Suzu 电话声",
    provider: "minimax",
    voiceId: "minimax-voice-id",
    apiKey: "development-only-minimax-key",
  });
  assert.equal(snapshot.customVoices.length, 1);
  assert.equal(snapshot.customVoices[0].provider, "minimax");
  assert.equal(JSON.stringify(snapshot).includes("development-only-minimax-key"), false);
  const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "voice-message", "custom-voices.json"), "utf8"));
  assert.equal(stored.voices[0].apiKey, "development-only-minimax-key");

  const cosyvoiceSnapshot = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "Suzu 复刻声",
    provider: "cosyvoice",
    voiceId: "cosyvoice-v3.5-plus-suzu-voice",
    apiKey: "development-only-bailian-key",
  });
  const cosyvoice = cosyvoiceSnapshot.customVoices.find((voice) => voice.provider === "cosyvoice");
  assert.ok(cosyvoice);
  assert.equal(cosyvoice.model, "cosyvoice-v3.5-plus");
  assert.equal(JSON.stringify(cosyvoiceSnapshot).includes("development-only-bailian-key"), false);
  const cosyvoiceStored = JSON.parse(await fs.readFile(path.join(dataRoot, "voice-message", "custom-voices.json"), "utf8"));
  assert.equal(cosyvoiceStored.voices[0].apiKey, "development-only-bailian-key");
});

test("contact voice configuration lists every contact and writes the selected source to the chosen contact only", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-contact-voice-library-data-"));
  const source = { id: "contact-source", name: "Suzu", agentId: "agent-source-contact" };
  const target = { id: "contact-target", name: "小林", agentId: "agent-target-contact" };
  const sourceRoot = resolveAgentDataRoot({ dataRoot, agentId: source.agentId });
  const targetRoot = resolveAgentDataRoot({ dataRoot, agentId: target.agentId });
  const [candidate] = await createVoiceCandidates({
    root: path.join(sourceRoot, "voice-design"),
    config: voiceConfig,
    input: { voicePrompt: "自然亲切", previewText: "你好，这是试听。", count: 1 },
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ output: { voice: "voice-library", preview_audio: { data: Buffer.from("preview").toString("base64") } } }) }),
  });
  await retainVoiceCandidate(path.join(sourceRoot, "voice-design"), candidate.id);
  const settings = { agentId: "", projectRoot: "" };
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot }),
      usageLedgerPath: () => path.join(dataRoot, "cost-ledger", "events.jsonl"),
    },
    connectionsService: { dashScopeSnapshot: async () => ({ configured: true, credentialStatus: "ready" }) },
    contactProjectsService: { snapshot: async () => ({ contacts: [source, target] }) },
  });

  const initial = await handlers.get("voice-design:snapshot")();
  assert.equal(initial.status, "needs-project");
  assert.deepEqual(initial.contacts.map((contact) => contact.name), ["Suzu", "小林"]);
  const qwen = initial.assignableVoices.find((voice) => voice.provider === "qwen" && voice.voiceId === candidate.voiceId);
  assert.ok(qwen);

  const afterQwen = await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: target.id,
    provider: "qwen",
    voiceId: qwen.voiceId,
    sourceContactId: qwen.sourceContactId,
    sourceCandidateId: qwen.sourceCandidateId,
  });
  const targetContact = afterQwen.contacts.find((contact) => contact.id === target.id);
  assert.equal(targetContact.voiceId, candidate.voiceId);
  assert.equal(JSON.parse(await fs.readFile(path.join(targetRoot, "voice-message", "config.json"), "utf8")).sourceAgentId, source.agentId);

  const afterCustom = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "电话声",
    provider: "minimax",
    voiceId: "minimax-voice-library",
    apiKey: "plain-development-key",
  });
  const minimax = afterCustom.assignableVoices.find((voice) => voice.provider === "minimax");
  assert.ok(minimax);
  assert.equal(JSON.stringify(afterCustom).includes("plain-development-key"), false);
  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: target.id,
    provider: "minimax",
    voiceId: minimax.voiceId,
    customVoiceId: minimax.id,
    sourceContactId: minimax.sourceContactId,
  });
  const targetConfig = JSON.parse(await fs.readFile(path.join(targetRoot, "voice-message", "config.json"), "utf8"));
  assert.equal(targetConfig.customVoiceSource, "global");
  assert.equal(targetConfig.customVoiceId, minimax.id);

  const afterAlibabaClone = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "Suzu 百炼复刻",
    provider: "cosyvoice",
    voiceId: "cosyvoice-v3.5-plus-suzu-voice",
    apiKey: "plain-bailian-development-key",
  });
  const cosyvoiceClone = afterAlibabaClone.assignableVoices.find((voice) => voice.provider === "cosyvoice" && voice.id);
  assert.ok(cosyvoiceClone);
  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: target.id,
    provider: "cosyvoice",
    voiceId: cosyvoiceClone.voiceId,
    customVoiceId: cosyvoiceClone.id,
    sourceContactId: cosyvoiceClone.sourceContactId,
  });
  const cosyvoiceCloneConfig = JSON.parse(await fs.readFile(path.join(targetRoot, "voice-message", "config.json"), "utf8"));
  assert.equal(cosyvoiceCloneConfig.provider, "cosyvoice");
  assert.equal(cosyvoiceCloneConfig.customVoiceSource, "global");
  assert.equal(cosyvoiceCloneConfig.customVoiceId, cosyvoiceClone.id);
});
