import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";
import {
  DirectVideoUnderstandingError,
  resolveVideoUnderstandingConfigPath,
} from "@suzu-lives/media-understanding/direct-video-understanding";
import { runSuzuLivesCli } from "../bin/suzu-lives.mjs";

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

async function createFakeTools(root) {
  if (process.platform === "win32") {
    const ffprobePath = path.join(root, "fake-ffprobe.cmd");
    const ffmpegPath = path.join(root, "fake-ffmpeg.cmd");
    await fs.writeFile(ffprobePath, "@echo off\r\necho {\"format\":{\"duration\":\"8.25\"}}\r\nexit /b 0\r\n", "utf8");
    await fs.writeFile(ffmpegPath, [
      "@echo off",
      "setlocal",
      "set \"OUTPUT=\"",
      ":next",
      "if \"%~1\"==\"\" goto write",
      "set \"OUTPUT=%~1\"",
      "shift",
      "goto next",
      ":write",
      "copy /b \"%SUZU_TEST_VIDEO_PREPARED_CLIP%\" \"%OUTPUT%\" >nul",
      "exit /b 0",
      "",
    ].join("\r\n"), "utf8");
    return { ffmpegPath, ffprobePath };
  }
  const ffprobePath = path.join(root, "fake-ffprobe");
  const ffmpegPath = path.join(root, "fake-ffmpeg");
  await fs.writeFile(ffprobePath, "#!/bin/sh\nprintf '%s\\n' '{\"format\":{\"duration\":\"8.25\"}}'\n", "utf8");
  await fs.writeFile(ffmpegPath, "#!/bin/sh\nfor value in \"$@\"; do output=\"$value\"; done\ncp \"$SUZU_TEST_VIDEO_PREPARED_CLIP\" \"$output\"\n", "utf8");
  await fs.chmod(ffprobePath, 0o755);
  await fs.chmod(ffmpegPath, 0o755);
  return { ffmpegPath, ffprobePath };
}

async function createFixture({ baseUrl = "http://127.0.0.1:9", apiKey = "fixture-video-key", preparedBytes = 64, video = {} } = {}) {
  const root = await temporaryDirectory("suzu-video-understanding-cli-");
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "claude-project");
  const videoPath = path.join(root, "fixture.mp4");
  const preparedClip = path.join(root, "fake-prepared.mp4");
  const configPath = path.join(dataRoot, "capabilities", "video-understanding", "config.json");
  const tools = await createFakeTools(root);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(videoPath, "not-a-real-video", "utf8");
  await fs.writeFile(preparedClip, Buffer.alloc(preparedBytes, 7));
  await fs.writeFile(configPath, JSON.stringify({
    provider: {
      api_key: apiKey,
      api_key_env: "VIDEO_FIXTURE_KEY",
      base_url: `${baseUrl}/v1/`,
      model: "fixture-video-model",
    },
    video: {
      fps: 1,
      timeout_seconds: 10,
      max_output_tokens: 321,
      temperature: 0.2,
      max_binary_bytes: 7_000_000,
      ffmpeg_path: tools.ffmpegPath,
      ffprobe_path: tools.ffprobePath,
      cache_enabled: true,
      cache_dir: "runtime/cache",
      ...video,
    },
  }), "utf8");
  return { dataRoot, projectRoot, videoPath, preparedClip, configPath };
}

async function startVideoServer(t, responses) {
  const requests = [];
  const queue = [...responses];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    const next = queue.shift() || { status: 500, body: JSON.stringify({ error: { message: "unexpected request" } }), contentType: "application/json" };
    response.writeHead(next.status || 200, { "content-type": next.contentType || "text/event-stream" });
    response.end(next.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function sseVideoResponse(summary, { id = "video-fixture", model = "fixture-video-response", usage = { prompt_tokens: 24, completion_tokens: 6 } } = {}) {
  return {
    body: [
      `data: ${JSON.stringify({ id, model, choices: [{ delta: { content: summary } }] })}\n\n`,
      `data: ${JSON.stringify({ usage })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
  };
}

function jsonVideoResponse(summary, { id = "video-json", model = "fixture-video-json", usage = { prompt_tokens: 18, completion_tokens: 4 } } = {}) {
  return {
    contentType: "application/json",
    body: JSON.stringify({ id, model, usage, choices: [{ message: { content: summary } }] }),
  };
}

function capabilityRequest(fixture, input, environment = {}) {
  return { input, dataRoot: fixture.dataRoot, workspaceRoot: fixture.projectRoot, environment };
}

async function invokeCli({ input, dataRoot, workspaceRoot, environment = {} }) {
  return execFileAsync(process.execPath, [
    CLI,
    "capability", "video-understanding", "analyze",
    "--input-json", JSON.stringify(input),
    "--data-root", dataRoot,
    "--workspace-root", workspaceRoot,
  ], {
    cwd: PACKAGE_ROOT,
    env: isolatedEnvironment(environment),
  });
}

async function assertCapabilityOwnedClip(dataRoot, clipPath) {
  const expectedRoot = path.join(await fs.realpath(dataRoot), "capabilities", "video-understanding");
  const actualRoot = await fs.realpath(path.dirname(path.dirname(clipPath)));
  assert.equal(actualRoot, expectedRoot);
}

test("stable video-understanding CLI keeps the OpenAI-compatible request, content-verified cache, retained clip, and software ledger", async (t) => {
  const server = await startVideoServer(t, [
    sseVideoResponse("第一份视频观察。"),
    jsonVideoResponse("--no-cache 的新观察。"),
  ]);
  const fixture = await createFixture({ baseUrl: `${server.baseUrl}/compatible` });
  const commonInput = {
    source: "https://video.example.test/clip.mp4?private=query#fragment",
    question: "这一段实际发生了什么？",
    cacheKey: "upstream-clip-42",
    configPath: fixture.configPath,
  };
  const environment = { SUZU_TEST_VIDEO_PREPARED_CLIP: fixture.preparedClip };

  const firstEnvelope = JSON.parse((await invokeCli(capabilityRequest(fixture, { ...commonInput, keepClip: true }, environment))).stdout);
  assert.equal(firstEnvelope.schemaVersion, 1);
  assert.equal(firstEnvelope.status, "ok");
  assert.equal(firstEnvelope.capabilityId, "video-understanding");
  assert.equal(firstEnvelope.action, "analyze");
  const first = firstEnvelope.result;
  assert.equal(first.status, "ok");
  assert.equal(first.summary, "第一份视频观察。");
  assert.equal(first.cached, false);
  assert.equal(first.source, "https://video.example.test/clip.mp4");
  assert.equal(first.durationSeconds, 8.25);
  assert.equal(first.fps, 1);
  assert.equal(first.responseModel, "fixture-video-response");
  await assertCapabilityOwnedClip(fixture.dataRoot, first.keptClipPath);
  assert.equal((await fs.stat(first.keptClipPath)).size, 64);
  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.url, "/compatible/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer fixture-video-key");
  assert.equal(request.headers.accept, "text/event-stream");
  assert.equal(request.headers["user-agent"], "suzu-lives-video-understanding/1.0");
  assert.equal(request.body.model, "fixture-video-model");
  assert.equal(request.body.max_tokens, 321);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.messages[1].content[0].type, "video_url");
  assert.equal(request.body.messages[1].content[0].fps, 1);
  assert.match(request.body.messages[1].content[0].video_url.url, /^data:video\/mp4;base64,/u);
  assert.match(request.body.messages[1].content[1].text, /时长约 8\.25 秒/u);
  assert.match(request.body.messages[1].content[1].text, /这一段实际发生了什么？/u);

  const cachePath = path.join(fixture.dataRoot, "capabilities", "video-understanding", "runtime", "cache", `${first.cacheKey}.json`);
  const stored = JSON.parse(await fs.readFile(cachePath, "utf8"));
  assert.equal(stored.summary, "第一份视频观察。");

  const cached = JSON.parse((await invokeCli(capabilityRequest(fixture, commonInput, environment))).stdout).result;
  assert.equal(cached.status, "ok");
  assert.equal(cached.cached, true);
  assert.equal(cached.summary, "第一份视频观察。");
  assert.equal(server.requests.length, 1);

  const bypassed = JSON.parse((await invokeCli(capabilityRequest(fixture, { ...commonInput, noCache: true }, environment))).stdout).result;
  assert.equal(bypassed.status, "ok");
  assert.equal(bypassed.cached, false);
  assert.equal(bypassed.summary, "--no-cache 的新观察。");
  assert.equal(server.requests.length, 2);
  assert.equal(JSON.parse(await fs.readFile(cachePath, "utf8")).summary, "第一份视频观察。");

  const agentId = stableAgentId(fixture.projectRoot);
  const ledgerPath = path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "cost-ledger", "events.jsonl");
  const events = (await fs.readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0].agentId, agentId);
  assert.equal(events[0].feature, "video-understanding");
  assert.equal(events[0].source, "视频理解");
  assert.equal(events[0].requestId, "video-fixture");
  assert.equal(events[0].metadata.durationSeconds, 8.25);
  assert.equal(events[1].requestId, "video-json");
});

test("video-understanding dry-run uses fake tools, needs no API Key, and retains only data-root clips", async () => {
  const fixture = await createFixture({ apiKey: "" });
  const result = JSON.parse((await invokeCli(capabilityRequest(fixture, {
    source: fixture.videoPath,
    dryRun: true,
    keepClip: true,
    configPath: fixture.configPath,
  }, { SUZU_TEST_VIDEO_PREPARED_CLIP: fixture.preparedClip }))).stdout).result;

  assert.equal(result.status, "dry-run");
  assert.equal(result.cached, false);
  assert.equal(result.base64Bytes, 88);
  assert.deepEqual(result.transcode.selected, { maxEdge: 854, crf: 29, audioBitrate: "56k" });
  assert.equal(result.transcode.attempts.length, 1);
  assert.equal((await fs.stat(result.keptClipPath)).size, 64);
  await assertCapabilityOwnedClip(fixture.dataRoot, result.keptClipPath);
  await assert.rejects(() => fs.stat(path.join(fixture.dataRoot, "capabilities", "video-understanding", "runtime", "cache", `${result.cacheKey}.json`)), /ENOENT/u);
  const agentId = stableAgentId(fixture.projectRoot);
  const ledgerPath = path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "cost-ledger", "events.jsonl");
  await assert.rejects(() => fs.stat(ledgerPath), /ENOENT/u);
});

test("video-understanding preserves VIDEO_UNDERSTANDING environment overrides over public config fields", async (t) => {
  const server = await startVideoServer(t, [sseVideoResponse("环境变量连接生效。", { model: "provider-response" })]);
  const fixture = await createFixture();
  const result = JSON.parse((await invokeCli(capabilityRequest(fixture, {
    source: fixture.videoPath,
    configPath: fixture.configPath,
  }, {
    SUZU_TEST_VIDEO_PREPARED_CLIP: fixture.preparedClip,
    VIDEO_UNDERSTANDING_API_KEY: "environment-video-key",
    VIDEO_UNDERSTANDING_BASE_URL: `${server.baseUrl}/override`,
    VIDEO_UNDERSTANDING_MODEL: "environment-video-model",
  }))).stdout).result;

  assert.equal(result.status, "ok");
  assert.equal(result.responseModel, "provider-response");
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/override/v1/chat/completions");
  assert.equal(server.requests[0].headers.authorization, "Bearer environment-video-key");
  assert.equal(server.requests[0].body.model, "environment-video-model");
});

test("video-understanding forwards the selected named connection's key, address, and model", async (t) => {
  const server = await startVideoServer(t, [sseVideoResponse("已使用命名 API。", { model: "provider-response" })]);
  const fixture = await createFixture();
  const previousClip = process.env.SUZU_TEST_VIDEO_PREPARED_CLIP;
  const originalWrite = process.stdout.write;
  process.env.SUZU_TEST_VIDEO_PREPARED_CLIP = fixture.preparedClip;
  process.stdout.write = () => true;
  try {
    await runSuzuLivesCli({
      args: ["capability", "video-understanding", "analyze", "--input-json", JSON.stringify({ source: fixture.videoPath, configPath: fixture.configPath }), "--data-root", fixture.dataRoot, "--workspace-root", fixture.projectRoot],
      connectionResolver: async ({ kind }) => kind === "video-understanding" ? { key: "named-video-key", baseUrl: `${server.baseUrl}/named`, model: "named-video-model" } : null,
    });
  } finally {
    process.stdout.write = originalWrite;
    if (previousClip === undefined) delete process.env.SUZU_TEST_VIDEO_PREPARED_CLIP;
    else process.env.SUZU_TEST_VIDEO_PREPARED_CLIP = previousClip;
  }
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/named/v1/chat/completions");
  assert.equal(server.requests[0].headers.authorization, "Bearer named-video-key");
  assert.equal(server.requests[0].body.model, "named-video-model");
});

test("video-understanding reports the fixed base64 size boundary before any provider request", async () => {
  const fixture = await createFixture({
    preparedBytes: 7_500_000,
    video: { max_binary_bytes: 8_000_000 },
  });
  await assert.rejects(
    () => invokeCli(capabilityRequest(fixture, {
      source: fixture.videoPath,
      configPath: fixture.configPath,
    }, { SUZU_TEST_VIDEO_PREPARED_CLIP: fixture.preparedClip })),
    (error) => {
      const response = JSON.parse(error.stdout);
      return error.code === 4
        && response.status === "error"
        && response.capabilityId === "video-understanding"
        && response.error.code === "clip_too_large"
        && /Base64 编码后有 10000000 字节/u.test(response.error.message);
    },
  );
});

test("video-understanding confines its explicit configuration path to the software data root", async () => {
  const root = await temporaryDirectory("suzu-video-config-boundary-");
  const dataRoot = path.join(root, "software-data");
  const allowed = resolveVideoUnderstandingConfigPath({ dataRoot, configPath: path.join(dataRoot, "capabilities", "video-understanding", "config.json") });
  assert.equal(allowed, path.join(dataRoot, "capabilities", "video-understanding", "config.json"));
  assert.throws(
    () => resolveVideoUnderstandingConfigPath({ dataRoot, configPath: path.join(root, "outside.json") }),
    DirectVideoUnderstandingError,
  );
});
