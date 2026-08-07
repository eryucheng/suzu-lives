import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";
import {
  DirectVoiceMessageError,
  resolveDirectVoiceRuntime,
  resolveVoiceMessageConfigPath,
  runDirectVoiceMessage,
} from "@suzu-lives/voice-message/direct-voice-message";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PACKAGE_ROOT, "bin", "suzu-lives.mjs");

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function isolatedEnvironment(extra = {}) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
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

async function invokeCli(args, environment = {}) {
  return execFileAsync(process.execPath, [CLI, "voice-message", ...args], {
    cwd: PACKAGE_ROOT,
    env: isolatedEnvironment(environment),
  });
}

test("voice-message --inspect checks only Suzu voice settings and never prints the key", async () => {
  const fixture = await createFixture();
  const result = await invokeCli([
    "--inspect",
    "--config", fixture.configPath,
    "--data-root", fixture.dataRoot,
    "--project-root", fixture.projectRoot,
  ], { VOICE_FIXTURE_KEY: "environment-fixture-key" });
  const inspection = JSON.parse(result.stdout);

  assert.equal(inspection.status, "ready");
  assert.equal(inspection.delivery, "conversation-attachment");
  assert.equal(inspection.outputFormat, "mp3");
  assert.equal(inspection.tts.model, "fixture-qwen-tts");
  assert.equal(inspection.tts.voiceConfigured, true);
  assert.equal(inspection.tts.apiKeyConfigured, true);
  assert.doesNotMatch(result.stdout, /environment-fixture-key|ilink/u);
  const agentId = stableAgentId(fixture.projectRoot);
  const ledgerPath = path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "cost-ledger", "events.jsonl");
  await assert.rejects(() => fs.stat(ledgerPath), /ENOENT/u);
});

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

test("voice-message rejects direct-delivery options", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    () => invokeCli(["测试", "--mode", "native", "--config", fixture.configPath, "--data-root", fixture.dataRoot, "--project-root", fixture.projectRoot], { VOICE_FIXTURE_KEY: "key" }),
    (error) => /--mode/u.test(String(error.message || error.stdout || error.stderr || "")),
  );
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
