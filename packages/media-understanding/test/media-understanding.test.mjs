import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createImageVisionPlan,
  createVideoUnderstandingPlan,
  executeImageVision,
  executeVideoUnderstanding,
  MediaUnderstandingError,
} from "../src/index.mjs";
import { CapabilityExecutionError, consumeCapabilityAuthorization, issueCapabilityAuthorization } from "@suzu-lives/capability-runtime";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authorization(root, abilityId, action, scope) {
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId, action, scope, now: () => 1_000 });
  return consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId, action, scope, now: () => 1_001 });
}

const imageConfiguration = { provider: { baseUrl: "https://vision.example.test/v1", model: "vision-test" } };
const videoConfiguration = {
  provider: { baseUrl: "https://video.example.test/v1", model: "video-test" },
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
};

test("creates an image-vision plan without contacting a provider or creating runtime data", () => {
  const root = temporaryDirectory("suzu-media-root-");
  const image = path.join(root, "image.jpg");
  fs.writeFileSync(image, "fixture", "utf8");

  const plan = createImageVisionPlan({ imagePath: image, question: "画面里有什么？", detail: "high", dataRoot: root });

  assert.equal(plan.status, "requires-provider-configuration");
  assert.equal(plan.willCallExternalService, false);
  assert.equal(plan.runtimeDataRoot, path.join(root, "capabilities", "image-vision"));
  assert.equal(fs.existsSync(plan.runtimeDataRoot), false);
});

test("image vision rejects a disabled gate before reading an image, resolving a credential, or calling a provider", async () => {
  const root = temporaryDirectory("suzu-image-gate-");
  const image = path.join(root, "fixture.jpg");
  fs.writeFileSync(image, "fixture", "utf8");
  let resolverCalled = false;
  let fetchCalled = false;
  await assert.rejects(
    () => executeImageVision({
      dataRoot: root,
      gate: { enabled: false, configured: true },
      configuration: imageConfiguration,
      authorization: {},
      invocation: { scope: {} },
      imagePath: image,
      credentialResolver: async () => { resolverCalled = true; return { apiKey: "fixture" }; },
      fetchImpl: async () => { fetchCalled = true; throw new Error("must not call"); },
    }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_DISABLED",
  );
  assert.equal(resolverCalled, false);
  assert.equal(fetchCalled, false);
});

test("image vision preserves the public OpenAI-compatible request shape only with private authorization and fake secure services", async () => {
  const root = temporaryDirectory("suzu-image-run-");
  const image = path.join(root, "fixture.jpg");
  fs.writeFileSync(image, "fixture", "utf8");
  const scope = { fixture: "image" };
  const requests = [];
  const result = await executeImageVision({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    configuration: imageConfiguration,
    authorization: authorization(root, "image-vision", "analyze-image", scope),
    invocation: { scope },
    imagePath: image,
    question: "画面里有什么？",
    credentialResolver: async ({ abilityId }) => { assert.equal(abilityId, "image-vision"); return { apiKey: "fixture-key" }; },
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "vision-1", model: "vision-test", choices: [{ message: { content: "一张测试图片。" } }] }) };
    },
  });
  const [endpoint, options] = requests[0];
  assert.equal(endpoint, "https://vision.example.test/v1/chat/completions");
  assert.equal(options.headers.Authorization, "Bearer fixture-key");
  assert.equal(JSON.parse(options.body).model, "vision-test");
  assert.equal(result.answer, "一张测试图片。");
  assert.equal(fs.existsSync(result.runPath), true);
});

test("image vision refuses a missing safe credential before provider access", async () => {
  const root = temporaryDirectory("suzu-image-credential-");
  const image = path.join(root, "fixture.jpg");
  fs.writeFileSync(image, "fixture", "utf8");
  const scope = { fixture: "missing" };
  let fetched = false;
  await assert.rejects(
    () => executeImageVision({
      dataRoot: root,
      gate: { enabled: true, configured: true },
      configuration: imageConfiguration,
      authorization: authorization(root, "image-vision", "analyze-image", scope),
      invocation: { scope },
      imagePath: image,
      fetchImpl: async () => { fetched = true; },
    }),
    (error) => error instanceof CapabilityExecutionError && error.code === "SECURE_CREDENTIAL_SOURCE_UNAVAILABLE",
  );
  assert.equal(fetched, false);
});

test("bounds video input and keeps its cache under the software data root", () => {
  const root = temporaryDirectory("suzu-video-root-");
  const video = path.join(root, "clip.mp4");
  fs.writeFileSync(video, "fixture", "utf8");

  const plan = createVideoUnderstandingPlan({ video, startSeconds: 5, endSeconds: 12, fps: 2, dataRoot: root });

  assert.equal(plan.sourceKind, "file");
  assert.equal(plan.willRunFfmpeg, false);
  assert.equal(plan.cacheDirectory, path.join(root, "capabilities", "video-understanding", "cache"));
  assert.throws(() => createVideoUnderstandingPlan({ video, startSeconds: 9, endSeconds: 9, dataRoot: root }), MediaUnderstandingError);
  assert.throws(() => createVideoUnderstandingPlan({ video: "file:///private.mp4", dataRoot: root }), MediaUnderstandingError);
});

test("video executor uses fake tools and a fake streaming OpenAI-compatible provider after verified authorization", async () => {
  const root = temporaryDirectory("suzu-video-run-");
  const video = path.join(root, "clip.mp4");
  fs.writeFileSync(video, "source-video", "utf8");
  const scope = { fixture: "video" };
  const commands = [];
  const requests = [];
  const runProcess = async (command, args) => {
    commands.push([command, args]);
    if (command === "ffprobe") return { stdout: JSON.stringify({ format: { duration: "8.5" } }), stderr: "", code: 0 };
    fs.mkdirSync(path.dirname(args.at(-1)), { recursive: true });
    fs.writeFileSync(args.at(-1), "prepared-video", "utf8");
    return { stdout: "", stderr: "", code: 0 };
  };
  const result = await executeVideoUnderstanding({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    configuration: videoConfiguration,
    authorization: authorization(root, "video-understanding", "analyze-video", scope),
    invocation: { scope },
    video,
    credentialResolver: async () => ({ apiKey: "fixture-video-key" }),
    runProcess,
    dependencyProbe: async () => true,
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, status: 200, text: async () => 'data: {"id":"video-1","model":"video-test","choices":[{"delta":{"content":"测试视频摘要。"}}]}\n\ndata: [DONE]\n' };
    },
  });
  const [, options] = requests[0];
  const body = JSON.parse(options.body);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(options.headers.Accept, "text/event-stream");
  assert.equal(result.summary, "测试视频摘要。");
  assert.equal(fs.existsSync(result.cachePath), true);
  assert.ok(commands.some(([command]) => command === "ffmpeg"));
});
