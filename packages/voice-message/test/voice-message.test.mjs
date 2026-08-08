import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeVoiceMessage, planVoiceMessage, VoiceMessageError } from "../src/index.mjs";
import { resolveDirectVoiceRuntime, runDirectVoiceMessage } from "../src/direct-voice-message.mjs";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { CapabilityExecutionError, consumeCapabilityAuthorization, issueCapabilityAuthorization } from "@suzu-lives/capability-runtime";

function authorization(root, scope) {
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId: "voice-message", action: "deliver-voice", scope, now: () => 1_000 });
  return consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "voice-message", action: "deliver-voice", scope, now: () => 1_001 });
}

test("voice planning creates MP3 locally and leaves delivery to the current conversation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-message-"));
  const plan = planVoiceMessage({ dataRoot: root, text: "你好，这是一段测试语音。" });

  assert.equal(plan.status, "ready-to-generate");
  assert.equal(plan.outputFormat, "mp3");
  assert.equal(plan.willReadSessionTokens, false);
  assert.equal(plan.willSendMessage, false);
  assert.equal(fs.existsSync(plan.audioDirectory), false);
  assert.match(plan.nextRequirement, /conversation-attachment/u);
});

test("generic executor rejects an unconfigured gate before it can invoke a voice action", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-gate-"));
  const scope = { fixture: "gate" };
  await assert.rejects(
    () => executeVoiceMessage({
      gate: { enabled: true, configured: false },
      authorization: {},
      invocation: { scope },
    }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_NOT_CONFIGURED",
  );
});

test("generic executor does not bypass the session-scoped voice delivery command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-session-"));
  const scope = { fixture: "session" };
  await assert.rejects(
    () => executeVoiceMessage({
      gate: { enabled: true, configured: true },
      authorization: authorization(root, scope),
      invocation: { scope },
    }),
    (error) => error instanceof VoiceMessageError && /当前 Suzu 会话/u.test(error.message),
  );
});

test("voice planning bounds text and requires one input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-message-input-"));
  assert.throws(() => planVoiceMessage({ dataRoot: root, text: "x".repeat(301) }), VoiceMessageError);
  assert.throws(() => planVoiceMessage({ dataRoot: root }), VoiceMessageError);
});

test("an Alibaba CosyVoice clone from the shared custom library resolves its saved key and synthesis model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-cosyvoice-clone-"));
  const agentId = "agent-1234567890abcdef";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  const voiceId = "cosyvoice-v3.5-plus-suzu-voice";
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "custom-voices.json"), JSON.stringify({
    schemaVersion: 1,
    voices: [{
      id: "cosyvoice-clone-1",
      name: "Suzu 百炼复刻",
      provider: "cosyvoice",
      voiceId,
      apiKey: "development-only-bailian-key",
    }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 3,
    provider: "cosyvoice",
    voiceId,
    customVoiceId: "cosyvoice-clone-1",
    customVoiceSource: "global",
  }));

  const runtime = resolveDirectVoiceRuntime({ dataRoot: root, agentId, environment: {} });
  assert.equal(runtime.tts.provider, "cosyvoice");
  assert.equal(runtime.tts.model, "cosyvoice-v3.5-plus");
  assert.equal(runtime.tts.voice, voiceId);
  assert.equal(runtime.tts.apiKey, "development-only-bailian-key");
});

test("an Alibaba CosyVoice clone uses its synthesis model, voice ID, and saved key when generating audio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-cosyvoice-clone-request-"));
  const agentId = "agent-abcdef1234567890";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  const voiceId = "cosyvoice-v3.5-plus-suzu-voice";
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "custom-voices.json"), JSON.stringify({
    schemaVersion: 1,
    voices: [{ id: "cosyvoice-clone-2", name: "Suzu 百炼复刻", provider: "cosyvoice", voiceId, apiKey: "development-only-bailian-key" }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 3,
    provider: "cosyvoice",
    voiceId,
    customVoiceId: "cosyvoice-clone-2",
    customVoiceSource: "global",
  }));
  const requests = [];
  const response = (value) => ({ ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  const result = await runDirectVoiceMessage({
    dataRoot: root,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    agentId,
    text: "你好，这是复刻音色测试。",
    environment: {},
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer") {
        return response({ request_id: "cosyvoice-clone-request", output: { audio: { url: "https://audio.example.test/clone.mp3" } } });
      }
      if (url === "https://audio.example.test/clone.mp3") {
        return { ok: true, arrayBuffer: async () => Buffer.from("mock-mp3-audio") };
      }
      throw new Error("unexpected request: " + url);
    },
  });
  const synthesis = requests[0];
  assert.equal(synthesis.options.headers.Authorization, "Bearer development-only-bailian-key");
  assert.deepEqual(JSON.parse(synthesis.options.body), {
    model: "cosyvoice-v3.5-plus",
    input: { text: "你好，这是复刻音色测试。", voice: voiceId, format: "mp3", sample_rate: 24000 },
  });
  assert.equal(result.status, "ok");
  assert.ok(fs.statSync(result.savedPath).size > 0);
});
