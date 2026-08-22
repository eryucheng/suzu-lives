import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeVoiceMessage, planVoiceMessage, VoiceMessageError } from "../src/index.mjs";
import { normalizeCustomTtsAdapter } from "../src/custom-tts-adapters.mjs";
import { resolveDirectVoiceRuntime, runDirectVoiceMessage, synthesizeDirectVoiceAudio } from "../src/direct-voice-message.mjs";
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

test("a legacy CosyVoice shape normalizes to an adapter but never supplies a credential", () => {
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

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    requireTtsCredentials: false,
  });
  assert.equal(runtime.tts.adapter, "dashscope-cosyvoice");
  assert.equal(runtime.tts.model, "cosyvoice-v3.5-plus");
  assert.equal(runtime.tts.voice, voiceId);
  assert.equal(runtime.tts.apiKey, "");
});

test("an Alibaba CosyVoice clone uses its synthesis model, voice ID, and selected shared API key", async () => {
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
    apiKeyOverride: "selected-shared-dashscope-key",
    baseUrlOverride: "https://dashscope.aliyuncs.com/api/v1",
    connectionName: "我的百炼语音",
    connectionType: "dashscope",
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
  assert.equal(synthesis.options.headers.Authorization, "Bearer selected-shared-dashscope-key");
  assert.equal(synthesis.options.headers.Authorization.includes("development-only-bailian-key"), false);
  assert.deepEqual(JSON.parse(synthesis.options.body), {
    model: "cosyvoice-v3.5-plus",
    input: { text: "你好，这是复刻音色测试。", voice: voiceId, format: "mp3", sample_rate: 24000 },
  });
  assert.equal(result.status, "ok");
  assert.ok(fs.statSync(result.savedPath).size > 0);
});

test("an OpenAI-compatible custom voice uses the selected shared API without storing a key in the voice record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-openai-adapter-"));
  const agentId = "agent-openai-voice-adapter";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  const customVoice = {
    id: "openai-voice-1",
    name: "Suzu 电话声",
    adapter: "openai-speech",
    model: "tts-1",
    voiceId: "nova",
  };
  fs.writeFileSync(path.join(root, "voice-message", "custom-voices.json"), JSON.stringify({
    schemaVersion: 2,
    voices: [customVoice],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 4,
    adapter: "openai-speech",
    voiceId: customVoice.voiceId,
    customVoiceId: customVoice.id,
    customVoiceSource: "global",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    apiKeyOverride: "selected-shared-api-key",
    baseUrlOverride: "https://tts.example.test/v1",
    connectionName: "我的 TTS",
    connectionType: "openai-compatible",
    environment: {},
  });
  assert.equal(runtime.tts.adapter, "openai-speech");
  assert.equal(runtime.tts.model, "tts-1");
  assert.equal(runtime.tts.apiKey, "selected-shared-api-key");
  assert.equal(JSON.stringify(customVoice).includes("apiKey"), false);

  const requests = [];
  const result = await synthesizeDirectVoiceAudio({
    runtime,
    text: "晚安，明天见。",
    agentId,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => Buffer.from("mock-openai-mp3") };
    },
  });
  assert.equal(result.format, "mp3");
  assert.equal(requests[0].url, "https://tts.example.test/v1/audio/speech");
  assert.equal(requests[0].options.headers.Authorization, "Bearer selected-shared-api-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "tts-1",
    input: "晚安，明天见。",
    voice: "nova",
    response_format: "mp3",
  });
});

test("a legacy OpenAI-labelled DashScope CosyVoice sound uses the DashScope synthesis endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-dashscope-auto-adapter-"));
  const agentId = "agent-0abc123456789def";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  const voiceId = "cosyvoice-v3.5-plus-bailian-legacy-suzu";
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "custom-voices.json"), JSON.stringify({
    schemaVersion: 2,
    voices: [{
      id: "legacy-dashscope-cosyvoice",
      name: "旧版百炼音色",
      adapter: "openai-speech",
      model: "cosyvoice-v3.5-plus",
      voiceId,
    }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 4,
    adapter: "openai-speech",
    voiceId,
    customVoiceId: "legacy-dashscope-cosyvoice",
    customVoiceSource: "global",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    apiKeyOverride: "selected-dashscope-key",
    baseUrlOverride: "https://dashscope.aliyuncs.com/api/v1",
    connectionName: "我的百炼 TTS",
    connectionType: "tts-api",
  });
  assert.equal(runtime.tts.adapter, "dashscope-cosyvoice");

  const requests = [];
  const response = (value) => ({ ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  await synthesizeDirectVoiceAudio({
    runtime,
    text: "这条旧配置应该走百炼接口。",
    agentId,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer") {
        return response({ request_id: "legacy-cosyvoice-request", output: { audio: { url: "https://audio.example.test/legacy.mp3" } } });
      }
      if (url === "https://audio.example.test/legacy.mp3") {
        return { ok: true, arrayBuffer: async () => Buffer.from("mock-cosyvoice-mp3") };
      }
      throw new Error("unexpected request: " + url);
    },
  });
  assert.equal(requests[0].url, "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "cosyvoice-v3.5-plus",
    input: { text: "这条旧配置应该走百炼接口。", voice: voiceId, format: "mp3", sample_rate: 24000 },
  });
});

test("DashScope native TTS adapters reject a compatible-mode URL before sending a malformed request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-dashscope-endpoint-"));
  const configPath = path.join(root, "voice-message", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    adapter: "dashscope-cosyvoice",
    model: "cosyvoice-v3.5-plus",
    voiceId: "longanhuan",
  }));

  assert.throws(
    () => resolveDirectVoiceRuntime({
      dataRoot: root,
      configPath,
      apiKeyOverride: "dashscope-key",
      baseUrlOverride: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      connectionType: "tts-api",
    }),
    (error) => error?.code === "tts_endpoint_incompatible" && /compatible-mode\/v1/u.test(error.message),
  );
});

test("Qwen-Audio TTS models use DashScope SpeechSynthesizer even when an old Qwen adapter was saved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-qwen-audio-routing-"));
  const configPath = path.join(root, "voice-message", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    adapter: "dashscope-qwen",
    model: "qwen-audio-3.0-tts-flash",
    voiceId: "longanhuan_v3.6",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    configPath,
    apiKeyOverride: "dashscope-key",
    baseUrlOverride: "https://dashscope.aliyuncs.com/api/v1",
    connectionType: "tts-api",
  });
  assert.equal(runtime.tts.adapter, "dashscope-cosyvoice");
  assert.equal(runtime.tts.protocol, "json");
});

test("CosyVoice v1 voice IDs cannot be sent to a Qwen-Audio TTS model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-v1-voice-model-"));
  const configPath = path.join(root, "voice-message", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    adapter: "dashscope-qwen",
    model: "qwen-audio-3.0-tts-flash",
    voiceId: "longwan",
  }));

  assert.throws(
    () => resolveDirectVoiceRuntime({
      dataRoot: root,
      configPath,
      apiKeyOverride: "dashscope-key",
      baseUrlOverride: "https://dashscope.aliyuncs.com/api/v1",
      connectionType: "tts-api",
    }),
    (error) => error?.code === "tts_voice_model_incompatible" && /longwan/u.test(error.message),
  );
});

test("CosyVoice v1 consumes DashScope SSE and downloads the final audio URL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-cosyvoice-sse-"));
  const configPath = path.join(root, "voice-message", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    adapter: "dashscope-cosyvoice",
    model: "cosyvoice-v1",
    voiceId: "longwan",
  }));
  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    configPath,
    apiKeyOverride: "dashscope-key",
    baseUrlOverride: "https://dashscope.aliyuncs.com/api/v1",
    connectionType: "tts-api",
  });
  assert.equal(runtime.tts.protocol, "dashscope-sse");

  const requests = [];
  const finalEvent = {
    request_id: "cosyvoice-v1-sse-request",
    output: {
      finish_reason: "stop",
      audio: { url: "https://audio.example.test/cosyvoice-v1.mp3" },
    },
    usage: { characters: 6 },
  };
  const result = await synthesizeDirectVoiceAudio({
    runtime,
    text: "你好，测试。",
    agentId: "agent-1234567890abcdef",
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: result\ndata: ${JSON.stringify({ output: { finish_reason: "null" } })}\n\n`));
            controller.enqueue(new TextEncoder().encode(`event: result\ndata: ${JSON.stringify(finalEvent)}\n\n`));
            controller.close();
          },
        });
        return {
          ok: true,
          headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/event-stream" : "" },
          body: stream,
        };
      }
      if (url === "https://audio.example.test/cosyvoice-v1.mp3") {
        return { ok: true, arrayBuffer: async () => Buffer.from("mock-cosyvoice-v1-mp3") };
      }
      throw new Error("unexpected request: " + url);
    },
  });

  assert.equal(requests[0].options.headers["X-DashScope-SSE"], "enable");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "cosyvoice-v1",
    input: { text: "你好，测试。", voice: "longwan", format: "mp3", sample_rate: 24000 },
  });
  assert.equal(result.requestId, "cosyvoice-v1-sse-request");
  assert.equal(result.audio.toString("utf8"), "mock-cosyvoice-v1-mp3");
});

test("Xiaomi MiMo TTS uses its chat-completions contract and decodes returned Base64 audio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-xiaomi-mimo-"));
  const configPath = path.join(root, "voice-message", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    adapter: "xiaomi-mimo-tts",
    voiceId: "mimo_default",
  }));
  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    configPath,
    apiKeyOverride: "mimo-api-key",
    baseUrlOverride: "https://api.xiaomimimo.com/v1",
    connectionName: "我的 MiMo",
    connectionType: "tts-api",
  });
  assert.equal(runtime.tts.adapter, "xiaomi-mimo-tts");
  assert.equal(runtime.tts.model, "mimo-v2.5-tts");

  const requests = [];
  const result = await synthesizeDirectVoiceAudio({
    runtime,
    text: "你好，今天过得怎么样？",
    agentId: "agent-1234567890abcdef",
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          id: "mimo-request-1",
          choices: [{ message: { audio: { data: Buffer.from("mock-mimo-wav-audio").toString("base64") } } }],
        })),
      };
    },
  });

  assert.equal(requests[0].url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(requests[0].options.headers["api-key"], "mimo-api-key");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "mimo-v2.5-tts",
    messages: [{ role: "assistant", content: "你好，今天过得怎么样？" }],
    audio: { format: "wav", voice: "mimo_default" },
  });
  assert.equal(result.requestId, "mimo-request-1");
  assert.equal(result.format, "wav");
  assert.equal(result.audio.toString("utf8"), "mock-mimo-wav-audio");
});

test("Xiaomi MiMo adapter rejects a general MiMo model before it creates a malformed TTS request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-xiaomi-mimo-model-"));
  const configPath = path.join(root, "voice-message", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    adapter: "xiaomi-mimo-tts",
    model: "mimo-v2.5",
    voiceId: "mimo_default",
  }));

  assert.throws(
    () => resolveDirectVoiceRuntime({
      dataRoot: root,
      configPath,
      apiKeyOverride: "mimo-api-key",
      baseUrlOverride: "https://api.xiaomimimo.com/v1",
      connectionType: "tts-api",
    }),
    (error) => error?.code === "tts_model_incompatible" && /mimo-v2\.5-tts/u.test(error.message),
  );
});

test("a locally saved custom JSON TTS adapter sends its template and decodes Base64 audio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-custom-json-adapter-"));
  const agentId = "agent-1234567890abcdef";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  const customAdapter = {
    id: "custom-mimo-adapter",
    name: "本机 MiMo 协议",
    endpointPath: "/chat/completions",
    requestHeaders: { "api-key": "{{apiKey}}" },
    requestBody: {
      model: "{{model}}",
      messages: [{ role: "assistant", content: "{{text}}" }],
      audio: { format: "wav", voice: "{{voice}}" },
    },
    responseMode: "json-base64",
    audioPath: "choices[0].message.audio.data",
    outputFormat: "wav",
  };
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "custom-tts-adapters.json"), JSON.stringify({
    schemaVersion: 1,
    adapters: [customAdapter],
  }));
  fs.writeFileSync(path.join(root, "voice-message", "custom-voices.json"), JSON.stringify({
    schemaVersion: 2,
    voices: [{
      id: "custom-mimo-voice",
      name: "自定义 MiMo 音色",
      adapter: "custom-http-tts",
      customAdapterId: customAdapter.id,
      model: "mimo-v2.5-tts",
      voiceId: "mimo_default",
    }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 5,
    adapter: "custom-http-tts",
    customAdapterId: customAdapter.id,
    voiceId: "mimo_default",
    customVoiceId: "custom-mimo-voice",
    customVoiceSource: "global",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    apiKeyOverride: "custom-mimo-key",
    baseUrlOverride: "https://tts.example.test/v1",
    connectionName: "我的自定义 TTS",
    connectionType: "tts-api",
  });
  assert.equal(runtime.tts.adapter, "custom-http-tts");
  assert.equal(runtime.tts.customAdapter.id, customAdapter.id);
  const requests = [];
  const result = await synthesizeDirectVoiceAudio({
    runtime,
    text: "你好，来自自定义协议。",
    agentId,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true,
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          choices: [{ message: { audio: { data: Buffer.from("custom-wav-audio").toString("base64") } } }],
        })),
      };
    },
  });
  assert.equal(requests[0].url, "https://tts.example.test/v1/chat/completions");
  assert.equal(requests[0].options.headers["api-key"], "custom-mimo-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "mimo-v2.5-tts",
    messages: [{ role: "assistant", content: "你好，来自自定义协议。" }],
    audio: { format: "wav", voice: "mimo_default" },
  });
  assert.equal(result.format, "wav");
  assert.equal(result.audio.toString("utf8"), "custom-wav-audio");
});

test("a custom TTS adapter can place the selected voice in an ElevenLabs-style endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-elevenlabs-template-"));
  const agentId = "agent-1234567890abcdef";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  const customAdapter = {
    id: "custom-elevenlabs-adapter",
    name: "ElevenLabs 请求格式",
    endpointPath: "/v1/text-to-speech/{{voice}}?output_format=mp3_44100_128",
    requestHeaders: { "xi-api-key": "{{apiKey}}" },
    requestBody: { text: "{{text}}", model_id: "{{model}}" },
    responseMode: "binary",
    audioPath: "",
    outputFormat: "mp3",
  };
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "custom-tts-adapters.json"), JSON.stringify({
    schemaVersion: 1,
    adapters: [customAdapter],
  }));
  fs.writeFileSync(path.join(root, "voice-message", "custom-voices.json"), JSON.stringify({
    schemaVersion: 2,
    voices: [{
      id: "elevenlabs-voice",
      name: "ElevenLabs 音色",
      adapter: "custom-http-tts",
      customAdapterId: customAdapter.id,
      model: "eleven_multilingual_v2",
      voiceId: "voice id/1",
    }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 5,
    adapter: "custom-http-tts",
    customAdapterId: customAdapter.id,
    voiceId: "voice id/1",
    customVoiceId: "elevenlabs-voice",
    customVoiceSource: "global",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    apiKeyOverride: "elevenlabs-key",
    baseUrlOverride: "https://api.elevenlabs.io",
    connectionName: "我的 ElevenLabs",
    connectionType: "tts-api",
  });
  const requests = [];
  const result = await synthesizeDirectVoiceAudio({
    runtime,
    text: "Hello from Suzu.",
    agentId,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => Buffer.from("elevenlabs-mp3-audio") };
    },
  });
  assert.equal(requests[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%20id%2F1?output_format=mp3_44100_128");
  assert.equal(requests[0].options.headers["xi-api-key"], "elevenlabs-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    text: "Hello from Suzu.",
    model_id: "eleven_multilingual_v2",
  });
  assert.equal(result.format, "mp3");
  assert.equal(result.audio.toString("utf8"), "elevenlabs-mp3-audio");
});

test("a profile-based ElevenLabs voice resolves its own service and API connection identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-elevenlabs-service-"));
  const agentId = "agent-abcdef1234567890";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "voice-services.json"), JSON.stringify({
    schemaVersion: 1,
    services: [{
      id: "service-elevenlabs",
      name: "ElevenLabs 英文语音",
      adapter: "elevenlabs-speech",
      connectionId: "connection-elevenlabs",
      model: "eleven_multilingual_v2",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  }));
  fs.writeFileSync(path.join(root, "voice-message", "voice-profiles.json"), JSON.stringify({
    schemaVersion: 1,
    profiles: [{
      id: "profile-elevenlabs",
      serviceId: "service-elevenlabs",
      name: "Narrator",
      voiceId: "voice id/1",
      model: "",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 6,
    voiceProfileId: "profile-elevenlabs",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    apiKeyOverride: "elevenlabs-service-key",
    baseUrlOverride: "",
    connectionName: "ElevenLabs 账户",
    connectionType: "tts-api",
  });
  assert.equal(runtime.selectionSource, "profile");
  assert.equal(runtime.voiceProfileId, "profile-elevenlabs");
  assert.equal(runtime.voiceServiceId, "service-elevenlabs");
  assert.equal(runtime.voiceConnectionId, "connection-elevenlabs");
  assert.equal(runtime.tts.adapter, "elevenlabs-speech");
  assert.equal(runtime.tts.baseUrl, "https://api.elevenlabs.io");
  assert.equal(runtime.tts.voice, "voice id/1");

  const requests = [];
  const result = await synthesizeDirectVoiceAudio({
    runtime,
    text: "Hello from a voice profile.",
    agentId,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => Buffer.from("profile-elevenlabs-audio") };
    },
  });
  assert.equal(requests[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%20id%2F1?output_format=mp3_44100_128");
  assert.equal(requests[0].options.headers["xi-api-key"], "elevenlabs-service-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    text: "Hello from a voice profile.",
    model_id: "eleven_multilingual_v2",
  });
  assert.equal(result.audio.toString("utf8"), "profile-elevenlabs-audio");
});

test("a profile-based custom protocol owns its endpoint while the selected API only provides its key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-custom-service-"));
  const agentId = "agent-custom-service-1234";
  const agentRoot = resolveAgentDataRoot({ dataRoot: root, agentId });
  fs.mkdirSync(path.join(root, "voice-message"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "voice-message"), { recursive: true });
  fs.writeFileSync(path.join(root, "voice-message", "custom-tts-adapters.json"), JSON.stringify({
    schemaVersion: 1,
    adapters: [{
      id: "custom-service-protocol",
      name: "供应商语音协议",
      baseUrl: "https://voice.example.test/v1",
      endpointPath: "/speech/{{voice}}",
      requestHeaders: { Authorization: "Bearer {{apiKey}}" },
      requestBody: { model: "{{model}}", text: "{{text}}" },
      responseMode: "binary",
      audioPath: "",
      outputFormat: "mp3",
    }],
  }));
  fs.writeFileSync(path.join(root, "voice-message", "voice-services.json"), JSON.stringify({
    schemaVersion: 1,
    services: [{
      id: "service-custom-tts",
      name: "供应商语音",
      adapter: "custom-http-tts",
      connectionId: "connection-custom-tts",
      customAdapterId: "custom-service-protocol",
      model: "speech-v1",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  }));
  fs.writeFileSync(path.join(root, "voice-message", "voice-profiles.json"), JSON.stringify({
    schemaVersion: 1,
    profiles: [{
      id: "profile-custom-tts",
      serviceId: "service-custom-tts",
      name: "供应商音色",
      voiceId: "voice id/1",
      model: "",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  }));
  fs.writeFileSync(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 6,
    voiceProfileId: "profile-custom-tts",
  }));

  const runtime = resolveDirectVoiceRuntime({
    dataRoot: root,
    agentId,
    apiKeyOverride: "custom-service-key",
    baseUrlOverride: "",
    connectionName: "供应商账户",
    connectionType: "tts-api",
  });
  assert.equal(runtime.tts.baseUrl, "https://voice.example.test/v1");
  const requests = [];
  await synthesizeDirectVoiceAudio({
    runtime,
    text: "Hello from a custom service.",
    agentId,
    ledgerPath: path.join(root, "cost-ledger", "events.jsonl"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => Buffer.from("custom-service-audio") };
    },
  });
  assert.equal(requests[0].url, "https://voice.example.test/v1/speech/voice%20id%2F1");
  assert.equal(requests[0].options.headers.Authorization, "Bearer custom-service-key");
});

test("custom TTS endpoint templates only accept the selected voice variable", () => {
  assert.throws(
    () => normalizeCustomTtsAdapter({
      id: "custom-invalid-template",
      name: "无效路径变量",
      endpointPath: "/v1/text-to-speech/{{apiKey}}",
      requestHeaders: {},
      requestBody: { text: "{{text}}" },
      responseMode: "binary",
      outputFormat: "mp3",
    }),
    /只支持 \{\{voice\}\}/u,
  );
});
