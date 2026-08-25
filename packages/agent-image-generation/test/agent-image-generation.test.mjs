import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentImageGenerationError, parseImageGenerationArgs, resolveImageGenerationApiConnection, runAgentImageGeneration } from "../src/index.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64");
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-agent-image-")); }
function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
async function fixture() { const dataRoot = await temporary(); const agentRoot = path.join(dataRoot, "agents", "fixture"); const reference = path.join(dataRoot, "source.png"); await fs.writeFile(reference, png); return { dataRoot, agentRoot, reference }; }

test("generation flags retain prompt and references while rejecting retired external send", () => {
  assert.deepEqual(parseImageGenerationArgs(["--prompt", "雨后的街道", "--ref", "identity=a.png", "--ref", "b.png"]), { refs: ["identity=a.png", "b.png"], prompt: "雨后的街道" });
  assert.throws(() => parseImageGenerationArgs(["--prompt", "雨后的街道", "--send"]), /不再支持 --send/u);
  assert.throws(() => parseImageGenerationArgs(["--prompt", "雨后的街道", "--backend", "api"]), /未知选项/u);
  assert.throws(() => parseImageGenerationArgs(["--prompt", "x", "--ref", "bad=a.png"]), AgentImageGenerationError);
});

test("API edit keeps role prompts, writes only the Agent data root, and appends the unified ledger", async () => {
  const values = await fixture(); let request;
  const configDirectory = path.join(values.dataRoot, "capabilities", "image-generation");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    adapter: "openai-images",
    reference_adapter: "openai-images-edit",
    reference_model: "fixture",
  }));
  const result = await runAgentImageGeneration({ agentRoot: values.agentRoot, agentId: "fixture", dataRoot: values.dataRoot, options: { prompt: "一张角色参考图", refs: ["identity=" + values.reference], out: "agent-output" }, connectionResolver: async () => ({ provider: "fixture", baseUrl: "https://images.example.test/v1", model: "fixture", apiKey: "key" }), fetchImpl: async (_url, options) => { request = options.body; return jsonResponse({ model: "fixture", id: "request-a", data: [{ b64_json: png.toString("base64") }] }); } });
  assert.equal(result.status, "ok"); assert.match(result.path, /agents[\\/]fixture[\\/]agent-output/u); assert.equal(await fs.stat(result.path).then((value) => value.isFile()), true); assert.match(request.get("prompt"), /role=identity/u);
  const events = (await fs.readFile(path.join(values.agentRoot, "cost-ledger", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); assert.equal(events.length, 1); assert.equal(events[0].feature, "image-edit"); assert.equal(events[0].metadata.referenceCount, 1);
});

test("API failures do not fall back, and a generated image stays in the local conversation delivery path", async () => {
  const values = await fixture(); const connectionResolver = async () => ({ baseUrl: "https://images.example.test/v1", model: "fixture", apiKey: "key" }); let requests = 0;
  await assert.rejects(() => runAgentImageGeneration({ agentRoot: values.agentRoot, dataRoot: values.dataRoot, options: { prompt: "不能回退", backend: "api" }, connectionResolver, fetchImpl: async () => { requests += 1; return jsonResponse({ error: { message: "provider down" } }, 503); } }), /图像 API 请求失败/u);
  assert.equal(requests, 1);
  const result = await runAgentImageGeneration({ agentRoot: values.agentRoot, dataRoot: values.dataRoot, options: { prompt: "保存到本地", backend: "api" }, connectionResolver, fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }) });
  assert.equal(result.sent, false); assert.equal(await fs.stat(result.path).then((value) => value.isFile()), true);
});

test("API generation requires the connection selected by the software", async () => {
  const values = await fixture();
  await assert.rejects(
    () => runAgentImageGeneration({ agentRoot: values.agentRoot, dataRoot: values.dataRoot, options: { prompt: "不读取旧环境变量" } }),
    /设置 → API/u,
  );
});
test("image generation resolves the selected custom protocol before invoking the workbench", async () => {
  const values = await fixture();
  const configDirectory = path.join(values.dataRoot, "capabilities", "image-generation");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    adapter: "custom-http-image",
    custom_adapter_id: "custom-image-fixture",
  }));
  await fs.writeFile(path.join(configDirectory, "custom-image-generation-adapters.json"), JSON.stringify({
    schemaVersion: 1,
    adapters: [{
      id: "custom-image-fixture",
      name: "Fixture Image",
      baseUrl: "https://custom.example.test",
      endpointPath: "/draw",
      requestHeaders: { Authorization: "Bearer {{apiKey}}" },
      requestBody: { prompt: "{{prompt}}" },
      responseMode: "json-url",
      imagePath: "result.url",
    }],
  }));
  const connection = await resolveImageGenerationApiConnection({
    dataRoot: values.dataRoot,
    connection: { apiKey: "key", model: "fixture", type: "generic-api" },
  });
  assert.equal(connection.imageGenerationAdapter, "custom-http-image");
  assert.equal(connection.customImageGenerationAdapter.name, "Fixture Image");
});

test("image generation stays on the local conversation delivery path", async () => {
  const values = await fixture(); const configDirectory = path.join(values.agentRoot, "image-generation"); await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({ delivery: { command: "fixture-external-delivery", session_key_env: "FIXTURE_IMAGE_SESSION" } }));
  const result = await runAgentImageGeneration({
    agentRoot: values.agentRoot,
    dataRoot: values.dataRoot,
    options: { prompt: "只生成" },
    environment: { FIXTURE_IMAGE_SESSION: "session-token" },
    connectionResolver: async () => ({ baseUrl: "https://images.example.test/v1", model: "fixture", apiKey: "key" }),
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }),
  });
  assert.equal(result.sent, false);
  assert.equal(await fs.stat(result.path).then((value) => value.isFile()), true);
});
