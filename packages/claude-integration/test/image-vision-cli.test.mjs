import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";
import { DirectImageVisionError, runDirectImageVision } from "@suzu-lives/media-understanding/direct-image-vision";
import { runSuzuLivesCli } from "../bin/suzu-lives.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PACKAGE_ROOT, "bin", "suzu-lives.mjs");
const SAMPLE_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

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

async function startVisionServer(t, responses) {
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
    const next = queue.shift() || { status: 500, body: { error: { message: "unexpected request" } } };
    response.writeHead(next.status || 200, { "content-type": "application/json" });
    response.end(JSON.stringify(next.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function createFixture({ baseUrl, vision = {} } = {}) {
  const root = await temporaryDirectory("suzu-image-vision-cli-");
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "claude-project");
  const imagePath = path.join(root, "fixture.gif");
  const configPath = path.join(dataRoot, "capabilities", "image-vision", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(imagePath, SAMPLE_GIF);
  await fs.writeFile(configPath, JSON.stringify({
    openai: { api_key: "config-fixture-key", base_url: `${baseUrl}/v1/`, model: "config-vision-model" },
    vision: {
      detail: "high",
      timeout_seconds: 10,
      max_output_tokens: 321,
      max_image_bytes: 1_572_864,
      max_edge: 1600,
      jpeg_quality: 90,
      retry_on_refusal: true,
      ...vision,
    },
  }), "utf8");
  return { dataRoot, projectRoot, imagePath, configPath };
}

function visionResponse(answer, { id = "vision-fixture", model = "fixture-vision", usage = { prompt_tokens: 12, completion_tokens: 3 } } = {}) {
  return { status: 200, body: { id, model, usage, choices: [{ message: { content: answer } }] } };
}

function capabilityRequest(fixture, input, environment = {}) {
  return { input, dataRoot: fixture.dataRoot, workspaceRoot: fixture.projectRoot, environment };
}

async function invokeCli({ input, dataRoot, workspaceRoot, environment = {} }) {
  return execFileAsync(process.execPath, [
    CLI,
    "capability", "image-vision", "analyze",
    "--input-json", JSON.stringify(input),
    "--data-root", dataRoot,
    "--workspace-root", workspaceRoot,
  ], {
    cwd: PACKAGE_ROOT,
    env: isolatedEnvironment(environment),
  });
}

test("stable image-vision CLI preserves request shape and the software ledger", async (t) => {
  const server = await startVisionServer(t, [visionResponse("画面中有一个测试像素。")]);
  const fixture = await createFixture({ baseUrl: server.baseUrl });

  const result = await invokeCli(capabilityRequest(fixture, {
    path: fixture.imagePath,
    question: "新问题优先吗？",
    configPath: fixture.configPath,
  }));

  const response = JSON.parse(result.stdout);
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.status, "ok");
  assert.equal(response.capabilityId, "image-vision");
  assert.equal(response.action, "analyze");
  assert.equal(response.result.answer, "画面中有一个测试像素。");
  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer config-fixture-key");
  assert.equal(request.headers["user-agent"], "suzu-lives-image-vision/1.0");
  assert.equal(request.body.model, "config-vision-model");
  assert.equal(request.body.max_tokens, 321);
  assert.equal(request.body.messages[1].content[0].text, "新问题优先吗？");
  assert.equal(request.body.messages[1].content[1].image_url.detail, "high");
  assert.match(request.body.messages[1].content[1].image_url.url, /^data:image\/gif;base64,/u);

  const agentId = stableAgentId(fixture.projectRoot);
  const ledgerPath = path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "cost-ledger", "events.jsonl");
  const events = (await fs.readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, agentId);
  assert.equal(events[0].feature, "image-vision");
  assert.equal(events[0].source, "图片识别");
  assert.equal(events[0].requestId, "vision-fixture");
  assert.equal(events[0].metadata.detail, "high");
  await assert.doesNotReject(() => fs.stat(path.join(fixture.dataRoot, "capabilities", "image-vision", "runtime")));
});

test("image-vision retries a safety refusal with the neutral visible-content prompt", async (t) => {
  const server = await startVisionServer(t, [
    { status: 403, body: { error: { message: "content policy blocked this request" } } },
    visionResponse("画面里有可见的人和物体。", { id: "retry-result" }),
  ]);
  const fixture = await createFixture({ baseUrl: server.baseUrl });

  const result = await invokeCli(capabilityRequest(fixture, {
    path: fixture.imagePath,
    question: "要识别什么？",
    configPath: fixture.configPath,
  }));

  assert.equal(JSON.parse(result.stdout).result.answer, "画面里有可见的人和物体。");
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].body.messages[1].content[0].text, "要识别什么？");
  assert.match(server.requests[1].body.messages[1].content[0].text, /中性的可见内容描述/u);
});

test("image-vision preserves VISION and OpenAI-compatible environment overrides over public config fields", async (t) => {
  const server = await startVisionServer(t, [visionResponse("环境变量连接生效。", { model: "provider-model" })]);
  const fixture = await createFixture({ baseUrl: "http://127.0.0.1:9" });

  const result = await invokeCli(capabilityRequest(fixture, {
    path: fixture.imagePath,
    question: "环境变量优先吗？",
    configPath: fixture.configPath,
  }, {
    VISION_API_KEY: "environment-fixture-key",
    VISION_BASE_URL: `${server.baseUrl}/compatible`,
    VISION_MODEL: "environment-vision-model",
  }));

  assert.equal(JSON.parse(result.stdout).result.answer, "环境变量连接生效。");
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/compatible/v1/chat/completions");
  assert.equal(server.requests[0].headers.authorization, "Bearer environment-fixture-key");
  assert.equal(server.requests[0].body.model, "environment-vision-model");
});

test("image-vision forwards the selected named connection's key, address, and model", async (t) => {
  const server = await startVisionServer(t, [visionResponse("已使用命名 API。", { model: "provider-model" })]);
  const fixture = await createFixture({ baseUrl: "http://127.0.0.1:9" });
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await runSuzuLivesCli({
      args: ["capability", "image-vision", "analyze", "--input-json", JSON.stringify({ path: fixture.imagePath, question: "是否转发？", configPath: fixture.configPath }), "--data-root", fixture.dataRoot, "--workspace-root", fixture.projectRoot],
      connectionResolver: async ({ kind }) => kind === "image-vision" ? { key: "named-key", baseUrl: `${server.baseUrl}/named`, model: "named-model" } : null,
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/named/v1/chat/completions");
  assert.equal(server.requests[0].headers.authorization, "Bearer named-key");
  assert.equal(server.requests[0].body.model, "named-model");
});

test("image-vision honors noRetry and keeps a refusal as an honest failure boundary", async (t) => {
  const server = await startVisionServer(t, [
    visionResponse("抱歉，我不能分析这张图片。", { id: "no-retry" }),
    visionResponse("抱歉，我无法分析这张图片。", { id: "refused-first" }),
    visionResponse("抱歉，我不能协助。", { id: "refused-second" }),
  ]);
  const fixture = await createFixture({ baseUrl: server.baseUrl });

  const noRetry = await invokeCli(capabilityRequest(fixture, {
    path: fixture.imagePath,
    question: "先不重试。",
    noRetry: true,
    configPath: fixture.configPath,
  }));
  assert.equal(JSON.parse(noRetry.stdout).result.answer, "抱歉，我不能分析这张图片。");
  assert.equal(server.requests.length, 1);

  await assert.rejects(
    () => invokeCli(capabilityRequest(fixture, {
      path: fixture.imagePath,
      question: "应当触发中性重试。",
      configPath: fixture.configPath,
    })),
    (error) => {
      const response = JSON.parse(error.stdout);
      return error.code === 4
        && response.status === "error"
        && response.capabilityId === "image-vision"
        && response.error.code === "vision_refused"
        && /VISION_REFUSED/u.test(response.error.message);
    },
  );
  assert.equal(server.requests.length, 3);
  const agentId = stableAgentId(fixture.projectRoot);
  const ledgerPath = path.join(resolveAgentDataRoot({ dataRoot: fixture.dataRoot, agentId }), "cost-ledger", "events.jsonl");
  const events = (await fs.readFile(ledgerPath, "utf8")).trim().split("\n");
  assert.equal(events.length, 3);
});

test("image-vision preserves the Pillow-unavailable format error without contacting a provider", async () => {
  const root = await temporaryDirectory("suzu-image-vision-no-pillow-");
  const dataRoot = path.join(root, "software-data");
  const configPath = path.join(dataRoot, "capabilities", "image-vision", "config.json");
  const imagePath = path.join(root, "unsupported.bmp");
  const ledgerPath = path.join(dataRoot, "agents", "fixture", "cost-ledger", "events.jsonl");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ openai: { api_key: "fixture", base_url: "http://127.0.0.1:9/v1", model: "fixture" } }), "utf8");
  await fs.writeFile(imagePath, "not-an-image", "utf8");

  await assert.rejects(
    () => runDirectImageVision({
      dataRoot,
      ledgerPath,
      agentId: "fixture",
      imagePath,
      configPath,
      pythonCommand: "python",
      pythonArgs: ["-S"],
      environment: isolatedEnvironment(),
    }),
    (error) => error instanceof DirectImageVisionError
      && error.exitCode === 4
      && /VISION_ERROR：该图片格式需要 Pillow 转换/u.test(error.stderr),
  );
});
