import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";
import { executeInternalCapability, parseInternalCapabilityRequest } from "@suzu-lives/capability-registry/internal-cli";
import {
  DirectVoiceMessageError,
  resolveDirectVoiceRuntime,
  resolveVoiceMessageConfigPath,
  runDirectVoiceMessage,
} from "@suzu-lives/voice-message/direct-voice-message";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createFixture({ local = {} } = {}) {
  const root = await temporaryDirectory("suzu-voice-message-cli-");
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "claude-project");
  const configPath = path.join(dataRoot, "capabilities", "voice-message", "config.json");
  const audioFile = path.join(root, "fixture.wav");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(audioFile, "fixture-wav-audio", "utf8");
  await fs.writeFile(configPath, JSON.stringify({
    voiceId: "fixture-voice",
    model: "fixture-qwen-tts",
    baseUrl: "https://tts.example.test/api/v1",
    languageType: "Chinese",
    apiKeyEnv: "VOICE_FIXTURE_KEY",
    timeoutMs: 5000,
    ffmpegPath: "ffmpeg",
    ...local,
  }), "utf8");
  return { root, dataRoot, projectRoot, configPath, audioFile };
}

function bytesResponse(value, { status = 200 } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body,
  };
}

test("saved Suzu voice and selected API connection override local defaults without bridge configuration", async () => {
  const fixture = await createFixture({ local: { voiceId: "saved-voice", model: "saved-model" } });
  const common = { dataRoot: fixture.dataRoot, configPath: fixture.configPath, environment: { VOICE_FIXTURE_KEY: "key" } };
  assert.equal(resolveDirectVoiceRuntime(common).tts.voice, "saved-voice");
  assert.equal(resolveDirectVoiceRuntime(common).tts.model, "saved-model");
  assert.equal(resolveDirectVoiceRuntime({ ...common, modelOverride: "selected-api-model" }).tts.model, "selected-api-model");
  assert.doesNotMatch(JSON.stringify(resolveDirectVoiceRuntime(common)), /recipient|contextToken|ilink/iu);
});

test("direct voice runner synthesizes, converts to MP3, and records usage without contacting WeChat", async () => {
  const fixture = await createFixture();
  const agentId = stableAgentId(fixture.projectRoot);
  const ledgerPath = path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "cost-ledger", "events.jsonl");
  const calls = [];
  const processCalls = [];
  const result = await runDirectVoiceMessage({
    dataRoot: fixture.dataRoot,
    ledgerPath,
    agentId,
    text: "你好，短语音测试。",
    configPath: fixture.configPath,
    apiKeyOverride: "selected-connection-key",
    baseUrlOverride: "https://selected.example.test/api/v1",
    environment: { VOICE_FIXTURE_KEY: "environment-tts-key" },
    fetchImpl: async (url, options = {}) => {
      calls.push([String(url), options]);
      if (String(url).includes("multimodal-generation")) {
        return bytesResponse({
          request_id: "tts-fixture-1",
          usage: { input_tokens: 8 },
          output: { audio: { url: "https://audio.example.test/result.wav" } },
        });
      }
      if (String(url) === "https://audio.example.test/result.wav") return bytesResponse(Buffer.from("fake-wav-audio"));
      throw new Error("unexpected URL " + url);
    },
    processRunner: async (command, args, label) => {
      processCalls.push([command, args, label]);
      await fs.writeFile(args.at(-1), "fake-mp3-audio", "utf8");
      return "";
    },
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.type, "suzu-voice-audio");
  assert.equal(result.mediaKind, "audio");
  assert.match(result.fileName, /\.mp3$/u);
  assert.equal(await fs.readFile(result.savedPath, "utf8"), "fake-mp3-audio");
  assert.ok(result.savedPath.startsWith(path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "voice-message", "audio")));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "https://selected.example.test/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(calls[0][1].headers.Authorization, "Bearer selected-connection-key");
  assert.equal(JSON.parse(calls[0][1].body).model, "fixture-qwen-tts");
  assert.equal(JSON.parse(calls[0][1].body).input.voice, "fixture-voice");
  assert.equal(processCalls.length, 1);
  assert.equal(processCalls[0][0], "ffmpeg");
  assert.ok(processCalls[0][1].includes("libmp3lame"));
  assert.ok(calls.every(([url]) => !/ilink|weixin/iu.test(url)));

  const events = (await fs.readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, agentId);
  assert.equal(events[0].feature, "voice-message-tts");
  assert.equal(events[0].requestId, "tts-fixture-1");
  assert.equal(events[0].metadata.outputFormat, "mp3");
});

test("a contact's MiniMax custom audio uses its local development key and produces an MP3", async () => {
  const root = await temporaryDirectory("suzu-minimax-contact-voice-");
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot);
  const agentId = stableAgentId(projectRoot);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  await fs.mkdir(path.join(agentRoot, "voice-message"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
      schemaVersion: 2,
      provider: "minimax",
      voiceId: "minimax-voice-1",
      customVoiceId: "custom-minimax-1",
    }), "utf8"),
    fs.writeFile(path.join(agentRoot, "voice-message", "custom-voices.json"), JSON.stringify({
      schemaVersion: 1,
      voices: [{
        id: "custom-minimax-1",
        name: "Suzu 的电话声",
        provider: "minimax",
        voiceId: "minimax-voice-1",
        apiKey: "minimax-development-key",
        model: "speech-2.8-hd",
      }],
    }), "utf8"),
  ]);
  const ledgerPath = path.join(agentRoot, "cost-ledger", "events.jsonl");
  const calls = [];
  const result = await runDirectVoiceMessage({
    dataRoot,
    ledgerPath,
    agentId,
    text: "你好，这是 MiniMax 的测试语音。",
    apiKeyOverride: "dashscope-key-that-must-not-be-used",
    baseUrlOverride: "https://dashscope.example.test/api/v1",
    modelOverride: "qwen-model-that-must-not-be-used",
    fetchImpl: async (url, options = {}) => {
      calls.push([String(url), options]);
      return bytesResponse({
        trace_id: "minimax-trace-1",
        base_resp: { status_code: 0, status_msg: "success" },
        data: {
          audio: Buffer.from("minimax-mp3").toString("hex"),
          extra_info: { usage_characters: 15 },
        },
      });
    },
    processRunner: async () => { throw new Error("MiniMax MP3 should not be converted again"); },
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.ttsRequestId, "minimax-trace-1");
  assert.equal(await fs.readFile(result.savedPath, "utf8"), "minimax-mp3");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.minimax.io/v1/t2a_v2");
  assert.equal(calls[0][1].headers.Authorization, "Bearer minimax-development-key");
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.model, "speech-2.8-hd");
  assert.equal(request.output_format, "hex");
  assert.equal(request.voice_setting.voice_id, "minimax-voice-1");
  assert.equal(request.audio_setting.format, "mp3");
  const [event] = (await fs.readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(event.provider, "MiniMax");
  assert.equal(event.requestId, "minimax-trace-1");
});

test("a saved voice can be assigned from the library to a different contact", async () => {
  const root = await temporaryDirectory("suzu-shared-contact-voice-");
  const dataRoot = path.join(root, "software-data");
  const sourceProject = path.join(root, "source-contact");
  const targetProject = path.join(root, "target-contact");
  await Promise.all([fs.mkdir(sourceProject), fs.mkdir(targetProject)]);
  const sourceAgentId = stableAgentId(sourceProject);
  const targetAgentId = stableAgentId(targetProject);
  const sourceRoot = resolveAgentDataRoot({ dataRoot, agentId: sourceAgentId });
  const targetRoot = resolveAgentDataRoot({ dataRoot, agentId: targetAgentId });
  await Promise.all([
    fs.mkdir(path.join(sourceRoot, "voice-design"), { recursive: true }),
    fs.mkdir(path.join(targetRoot, "voice-message"), { recursive: true }),
    fs.mkdir(path.join(dataRoot, "voice-message"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(sourceRoot, "voice-design", "candidates.jsonl"), `${JSON.stringify({ id: "retained-source", voiceId: "qwen-shared-voice", retainedAt: "2026-08-08T00:00:00.000Z" })}\n`, "utf8"),
    fs.writeFile(path.join(targetRoot, "voice-message", "config.json"), JSON.stringify({
      schemaVersion: 3,
      provider: "qwen",
      voiceId: "qwen-shared-voice",
      sourceAgentId,
      sourceCandidateId: "retained-source",
    }), "utf8"),
    fs.writeFile(path.join(dataRoot, "voice-message", "custom-voices.json"), JSON.stringify({
      schemaVersion: 1,
      voices: [{
        id: "global-minimax-voice",
        name: "电话声",
        provider: "minimax",
        voiceId: "minimax-shared-voice",
        apiKey: "global-development-key",
        model: "speech-2.8-hd",
      }],
    }), "utf8"),
  ]);

  const qwenRuntime = resolveDirectVoiceRuntime({
    dataRoot,
    agentId: targetAgentId,
    environment: { DASHSCOPE_API_KEY: "dashscope-key" },
  });
  assert.equal(qwenRuntime.tts.voice, "qwen-shared-voice");

  await fs.writeFile(path.join(targetRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 3,
    provider: "minimax",
    voiceId: "minimax-shared-voice",
    customVoiceId: "global-minimax-voice",
    customVoiceSource: "global",
  }), "utf8");
  const calls = [];
  const result = await runDirectVoiceMessage({
    dataRoot,
    agentId: targetAgentId,
    ledgerPath: path.join(targetRoot, "cost-ledger", "events.jsonl"),
    text: "给不同联系人使用同一个声音。",
    fetchImpl: async (url, options = {}) => {
      calls.push([String(url), options]);
      return bytesResponse({
        trace_id: "shared-minimax-trace",
        base_resp: { status_code: 0, status_msg: "success" },
        data: { audio: Buffer.from("shared-minimax-mp3").toString("hex") },
      });
    },
    processRunner: async () => { throw new Error("MiniMax MP3 should not be converted again"); },
  });
  assert.equal(result.status, "ok");
  assert.equal(calls[0][1].headers.Authorization, "Bearer global-development-key");
  assert.equal(JSON.parse(calls[0][1].body).voice_setting.voice_id, "minimax-shared-voice");
});

test("local audio is converted to MP3 without TTS credentials or external delivery", async () => {
  const fixture = await createFixture();
  const agentId = stableAgentId(fixture.projectRoot);
  let fetched = false;
  const result = await runDirectVoiceMessage({
    dataRoot: fixture.dataRoot,
    agentId,
    audioFile: fixture.audioFile,
    configPath: fixture.configPath,
    environment: {},
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
    processRunner: async (_command, args) => {
      await fs.writeFile(args.at(-1), "converted-mp3", "utf8");
      return "";
    },
  });
  assert.equal(result.mediaKind, "audio");
  assert.match(result.savedPath, /\.mp3$/u);
  assert.ok(result.savedPath.startsWith(path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "voice-message", "audio")));
  assert.equal(await fs.readFile(result.savedPath, "utf8"), "converted-mp3");
  assert.equal(fetched, false);
});

test("voice-message confines its software configuration file to the data root", async () => {
  const root = await temporaryDirectory("suzu-voice-config-boundary-");
  const dataRoot = path.join(root, "software-data");
  assert.equal(
    resolveVoiceMessageConfigPath({ dataRoot, configPath: path.join(dataRoot, "capabilities", "voice-message", "config.json") }),
    path.join(dataRoot, "capabilities", "voice-message", "config.json"),
  );
  assert.throws(
    () => resolveVoiceMessageConfigPath({ dataRoot, configPath: path.join(root, "outside.json") }),
    DirectVoiceMessageError,
  );
});

test("voice-message rejects a missing contact or a voice that is not in that contact's candidate library", async () => {
  const root = await temporaryDirectory("suzu-contact-voice-boundary-");
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot);
  const agentId = stableAgentId(projectRoot);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  await Promise.all([
    fs.mkdir(path.join(agentRoot, "voice-design"), { recursive: true }),
    fs.mkdir(path.join(agentRoot, "voice-message"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(agentRoot, "voice-design", "candidates.jsonl"), `${JSON.stringify({ id: "candidate", voiceId: "available-voice" })}\n`, "utf8"),
    fs.writeFile(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({ voiceId: "other-contact-voice" }), "utf8"),
  ]);
  assert.throws(
    () => resolveDirectVoiceRuntime({ dataRoot, agentId, environment: { DASHSCOPE_API_KEY: "key" } }),
    (error) => error instanceof DirectVoiceMessageError && error.code === "voice_not_available_for_agent",
  );
  await assert.rejects(
    () => runDirectVoiceMessage({ dataRoot, text: "没有联系人" }),
    (error) => error instanceof DirectVoiceMessageError && error.code === "agent_identity_missing",
  );
});

test("voice-message ignores the unset timeout sentinel from a selected DashScope connection", async () => {
  const fixture = await createFixture();
  const agentId = stableAgentId(fixture.projectRoot);
  const request = parseInternalCapabilityRequest({
    positional: ["voice-message", "inspect"],
    options: { "input-json": JSON.stringify({ configPath: fixture.configPath }) },
  });

  const result = await executeInternalCapability({
    request,
    runtime: {
      dataRoot: fixture.dataRoot,
      agentId,
      ledgerPath: path.join(fixture.root, "cost-ledger", "events.jsonl"),
      connection: {
        type: "dashscope",
        apiKey: "selected-dashscope-key",
        key: "selected-dashscope-key",
        baseUrl: "https://selected.example.test/api/v1",
        model: "selected-dashscope-model",
        timeoutMs: 0,
      },
      environment: {},
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.tts.apiKeyConfigured, true);
  assert.equal(result.tts.voiceConfigured, true);
});
