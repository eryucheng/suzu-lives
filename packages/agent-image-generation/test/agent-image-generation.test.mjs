import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentImageGenerationError, listComfyWorkflows, parseImageGenerationArgs, runAgentImageGeneration, validateComfyWorkflows } from "../src/index.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64");
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-agent-image-")); }
function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
async function fixture() { const dataRoot = await temporary(); const agentRoot = path.join(dataRoot, "agents", "fixture"); const reference = path.join(dataRoot, "source.png"); await fs.writeFile(reference, png); return { dataRoot, agentRoot, reference }; }

test("generation flags retain prompt, backend, references, and workflow commands while rejecting retired external send", () => {
  assert.deepEqual(parseImageGenerationArgs(["--prompt", "雨后的街道", "--backend", "api", "--ref", "identity=a.png", "--ref", "b.png", "--seed", "7"]), { refs: ["identity=a.png", "b.png"], prompt: "雨后的街道", backend: "api", seed: 7 });
  assert.throws(() => parseImageGenerationArgs(["--prompt", "雨后的街道", "--send"]), /不再支持 --send/u);
  assert.throws(() => parseImageGenerationArgs(["--prompt", "x", "--ref", "bad=a.png"]), AgentImageGenerationError);
});

test("API edit keeps role prompts, writes only the Agent data root, and appends the unified ledger", async () => {
  const values = await fixture(); let request;
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

test("ComfyUI registry files validate, list, select their configured workflow, and bind reference slots", async () => {
  const values = await fixture(); const configDir = path.join(values.dataRoot, "capabilities", "image-generation"); const workflows = path.join(configDir, "workflows"); await fs.mkdir(workflows, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ default_backend: "comfyui", comfyui: { registry: "workflows/registry.json", default_workflow: "local" } }));
  await fs.writeFile(path.join(workflows, "registry.json"), JSON.stringify({ version: 1, workflows: { local: { enabled: true, description: "本地", file: "local.json", bindings: { prompt: { node: "1", input: "text" }, seed: { node: "2", input: "seed" } }, defaults: {}, reference_slots: [{ node: "3", input: "image", roles: ["style"], required: true }], output_nodes: ["4"] } } }));
  await fs.writeFile(path.join(workflows, "local.json"), JSON.stringify({ "1": { class_type: "Text", inputs: { text: "" } }, "2": { class_type: "Seed", inputs: { seed: 0 } }, "3": { class_type: "LoadImage", inputs: { image: "" } }, "4": { class_type: "SaveImage", inputs: {} } }));
  assert.deepEqual((await listComfyWorkflows({ dataRoot: values.dataRoot })).workflows.map((item) => item.id), ["local"]); assert.equal((await validateComfyWorkflows({ dataRoot: values.dataRoot })).status, "valid");
  let submitted; const result = await runAgentImageGeneration({ agentRoot: values.agentRoot, agentId: "fixture", dataRoot: values.dataRoot, options: { prompt: "本地图", refs: ["style=" + values.reference], seed: 42 }, fetchImpl: async (url, options) => { if (url.endsWith("/upload/image")) return jsonResponse({ name: "ref.png", subfolder: "suzu" }); if (url.endsWith("/prompt")) { submitted = JSON.parse(options.body); return jsonResponse({ prompt_id: "local-a" }); } if (url.includes("/history/")) return jsonResponse({ "local-a": { outputs: { "4": { images: [{ filename: "out.png" }] } } } }); return new Response(png, { headers: { "content-type": "image/png" } }); } });
  assert.equal(result.backend, "comfyui"); assert.equal(result.workflow, "local"); assert.equal(submitted.prompt["2"].inputs.seed, 42); assert.equal(submitted.prompt["3"].inputs.image, "suzu/ref.png");
});

test("registry rejects ComfyUI interface JSON rather than pretending it is executable", async () => {
  const values = await fixture(); const configDir = path.join(values.dataRoot, "capabilities", "image-generation"); const workflows = path.join(configDir, "workflows"); await fs.mkdir(workflows, { recursive: true }); await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ comfyui: { registry: "workflows/registry.json" } })); await fs.writeFile(path.join(workflows, "registry.json"), JSON.stringify({ version: 1, workflows: { bad: { enabled: true, file: "bad.json", bindings: { prompt: { node: "1", input: "text" } }, defaults: {}, reference_slots: [], output_nodes: [] } } })); await fs.writeFile(path.join(workflows, "bad.json"), JSON.stringify({ nodes: [] }));
  assert.deepEqual((await listComfyWorkflows({ dataRoot: values.dataRoot })).workflows.map((item) => item.id), ["bad"]);
  await assert.rejects(() => validateComfyWorkflows({ dataRoot: values.dataRoot }), /界面工作流/u);
});
