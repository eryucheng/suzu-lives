import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCandidates, downloadImageUrl, readRuns, validateComfyRegistry, ImageWorkbenchError } from "../src/index.mjs";

const credential = () => String.fromCharCode(120, 121, 122);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64");
const api = { baseUrl: "https://example.test/v1", model: "image-model", apiKey: credential() };
const input = { prompt: "一幅测试图", backend: "api", count: 1, size: "1024x1024" };
async function root() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-images-")); }
function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function bytesResponse(value, status = 200, type = "image/png") { return new Response(value, { status, headers: { "content-type": type } }); }
function structuralPng(totalBytes) { const data = Buffer.alloc(totalBytes); Buffer.from([137,80,78,71,13,10,26,10]).copy(data, 0); data.writeUInt32BE(13, 8); data.write("IHDR", 12); data.writeUInt32BE(1, 16); data.writeUInt32BE(1, 20); data[24] = 8; data[25] = 2; const idat = 33; data.writeUInt32BE(totalBytes - 57, idat); data.write("IDAT", idat + 4); const iend = totalBytes - 12; data.writeUInt32BE(0, iend); data.write("IEND", iend + 4); return data; }

test("API generation saves a software-owned candidate run without touching references", async () => {
  const target = await root(); let request;
  const run = await createCandidates({ root: target, connection: api, input, fetchImpl: async (_url, options) => { request = options; return jsonResponse({ model: "image-model", id: "request-a", data: [{ b64_json: png.toString("base64") }] }); } });
  assert.equal(run.status, "complete"); assert.equal(run.candidates.length, 1); assert.equal(request.headers.Authorization.includes(credential()), true);
  assert.equal((await readRuns(target))[0].note.includes("尚未写入视觉参考库"), true);
  assert.equal(await fs.stat(path.join(target, run.candidates[0].file)).then((item) => item.isFile()), true);
});

test("DashScope image generation uses the model saved on the selected API connection", async () => {
  let request;
  const run = await createCandidates({
    root: await root(),
    connection: {
      apiKey: credential(),
      baseUrl: "https://dashscope.example.test/api/v1",
      model: "my-dashscope-image-model",
      type: "dashscope",
    },
    input,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return jsonResponse({
        request_id: "dashscope-model-request",
        output: { choices: [{ message: { content: [{ image: "https://cdn.example.test/image.png" }] } }] },
      });
    },
    imageDownloader: async () => png,
  });
  assert.equal(run.candidates[0].model, "my-dashscope-image-model");
  assert.equal(request.model, "my-dashscope-image-model");
});

test("API references use the edit endpoint and role-aware multipart request", async () => {
  let target = "";
  await createCandidates({ root: await root(), connection: api, input: { ...input, prompt: "参考测试" }, references: [{ id: "ref-a", role: "identity", description: "人物", filename: "ref.png", mime: "image/png", data: png }], fetchImpl: async (url, options) => { target = url; assert.equal(options.body instanceof FormData, true); assert.match(String(options.body.get("prompt")), /Reference image roles/); return jsonResponse({ data: [{ b64_json: png.toString("base64") }] }); } });
  assert.equal(target.endsWith("/images/edits"), true);
});

test("drawing keeps its default 12-reference limit unless a caller explicitly requests a bounded override", async () => {
  const references = Array.from({ length: 13 }, (_, index) => ({ id: "ref-" + index, role: "identity", filename: "ref.png", mime: "image/png", data: png }));
  await assert.rejects(() => createCandidates({ root: root(), connection: api, input, references, fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }) }), /参考图数量无效/u);
  const fullSet = Array.from({ length: 16 }, (_, index) => ({ id: "ref-" + index, role: "identity", filename: "ref.png", mime: "image/png", data: png }));
  const run = await createCandidates({ root: await root(), connection: api, input, references: fullSet, maxReferences: 16, fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }) });
  assert.equal(run.status, "complete"); assert.equal(run.references.length, 16);
});

test("API preserves generation and edit extra request bodies", async () => {
  let generation; let edit;
  const connection = { ...api, extraBody: { provider_flag: true }, editExtraBody: { edit_flag: "yes" } };
  await createCandidates({ root: await root(), connection, input, fetchImpl: async (_url, options) => { generation = JSON.parse(options.body); return jsonResponse({ data: [{ b64_json: png.toString("base64") }] }); } });
  await createCandidates({ root: await root(), connection, input, references: [{ id: "ref", role: "style", description: "风格", filename: "ref.png", mime: "image/png", data: png }], fetchImpl: async (_url, options) => { edit = options.body; return jsonResponse({ data: [{ b64_json: png.toString("base64") }] }); } });
  assert.equal(generation.provider_flag, true); assert.equal(edit.get("edit_flag"), "yes"); assert.equal(edit.has("provider_flag"), false);
});

test("ComfyUI accepts only registered enabled API-format workflows", () => {
  assert.throws(() => validateComfyRegistry({ version: 1, workflows: { "bad": { enabled: true, workflow: { nodes: [] }, bindings: { prompt: {} }, reference_slots: [], output_nodes: [] } } }), ImageWorkbenchError);
  const registry = validateComfyRegistry({ version: 1, workflows: { "ok": { enabled: true, workflow: { "1": { class_type: "Text", inputs: { text: "" } } }, bindings: { prompt: { node: "1", input: "text" } }, defaults: {}, reference_slots: [], output_nodes: [] } } });
  assert.equal(registry.workflows.ok.enabled, true);
});

test("ComfyUI submits only an enabled registered workflow", async () => {
  const registry = { version: 1, workflows: { "local-test": { enabled: true, workflow: { "1": { class_type: "Text", inputs: { text: "" } }, "2": { class_type: "SaveImage", inputs: {} } }, bindings: { prompt: { node: "1", input: "text" } }, defaults: {}, reference_slots: [], output_nodes: ["2"] } } };
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "prompt-a" }); if (url.includes("/history/")) return jsonResponse({ "prompt-a": { outputs: { "2": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }); return bytesResponse(png); };
  const run = await createCandidates({ root: await root(), connection: { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 }, registry, input: { prompt: "本地图", backend: "comfyui", workflow: "local-test", count: 1, size: "512x512" }, fetchImpl });
  assert.equal(run.candidates[0].workflow, "local-test");
  assert.equal(calls.some((url) => url.endsWith("/prompt")), true);
});

test("ComfyUI submits the selected seed and reports history HTTP errors without polling", async () => {
  const registry = { version: 1, workflows: { "seeded": { enabled: true, workflow: { "1": { class_type: "Text", inputs: { text: "" } }, "2": { class_type: "Seed", inputs: { seed: 0 } }, "3": { class_type: "SaveImage", inputs: {} } }, bindings: { prompt: { node: "1", input: "text" }, seed: { node: "2", input: "seed" } }, defaults: {}, reference_slots: [], output_nodes: ["3"] } } };
  let submitted;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/prompt")) { submitted = JSON.parse(options.body); return jsonResponse({ prompt_id: "seed-a" }); }
    if (url.includes("/history/")) return jsonResponse({ "seed-a": { outputs: { "3": { images: [{ filename: "out.png" }] } } } });
    return bytesResponse(png);
  };
  await createCandidates({ root: await root(), connection: { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 }, registry, input: { prompt: "种子", backend: "comfyui", workflow: "seeded", seed: 42, count: 1, size: "512x512" }, fetchImpl });
  assert.equal(submitted.prompt["2"].inputs.seed, 42);
  const historyErrorRoot = await root();
  await assert.rejects(() => createCandidates({ root: historyErrorRoot, connection: { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 }, registry, input: { prompt: "失败", backend: "comfyui", workflow: "seeded", count: 1, size: "512x512" }, fetchImpl: async (url) => url.endsWith("/prompt") ? jsonResponse({ prompt_id: "history-error" }) : jsonResponse({}, 503) }), /查询任务失败：HTTP 503/u);
  const rejectRoot = await root(); const viewErrorRoot = await root();
  await assert.rejects(() => createCandidates({ root: rejectRoot, connection: { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 }, registry, input: { prompt: "拒绝", backend: "comfyui", workflow: "seeded", count: 1, size: "512x512" }, fetchImpl: async () => jsonResponse({ node_errors: { bad: "fixture" } }, 400) }), /ComfyUI 拒绝工作流/u);
  await assert.rejects(() => createCandidates({ root: viewErrorRoot, connection: { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 }, registry, input: { prompt: "下载失败", backend: "comfyui", workflow: "seeded", count: 1, size: "512x512" }, fetchImpl: async (url) => url.endsWith("/prompt") ? jsonResponse({ prompt_id: "view-error" }) : url.includes("/history/") ? jsonResponse({ "view-error": { outputs: { "3": { images: [{ filename: "out.png" }] } } } }) : bytesResponse("", 502) }), /下载 ComfyUI 输出失败：HTTP 502/u);
});

test("ComfyUI aborts the active request for upload, prompt, history, and view failures", async () => {
  const registry = { version: 1, workflows: { "stages": { enabled: true, workflow: { "1": { class_type: "Text", inputs: { text: "" } }, "2": { class_type: "LoadImage", inputs: { image: "" } }, "3": { class_type: "SaveImage", inputs: {} } }, bindings: { prompt: { node: "1", input: "text" } }, defaults: {}, reference_slots: [{ node: "2", input: "image", roles: ["style"], required: false }], output_nodes: ["3"] } } };
  const connection = { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 }; const withReference = { prompt: "阶段", backend: "comfyui", workflow: "stages", count: 1, size: "512x512" }; const reference = [{ id: "ref", role: "style", filename: "ref.png", mime: "image/png", data: png }];
  const runCase = async (fetchImpl, expected, references = []) => { const state = {}; const target = await root(); await assert.rejects(() => createCandidates({ root: target, connection, registry, input: withReference, references, fetchImpl: async (url, options) => { options.signal.addEventListener("abort", () => { state.aborted = true; }); return fetchImpl(url, options); } }), expected); assert.equal(state.aborted, true); };
  await runCase(async () => jsonResponse({}, 400), /上传参考图失败/u, reference);
  await runCase(async () => jsonResponse({}, 400), /ComfyUI 拒绝工作流/u);
  await runCase(async (url) => url.endsWith("/prompt") ? jsonResponse({ prompt_id: "history" }) : jsonResponse({}, 503), /查询任务失败/u);
  await runCase(async (url) => url.endsWith("/prompt") ? jsonResponse({ prompt_id: "view" }) : url.includes("/history/") ? jsonResponse({ view: { outputs: { "3": { images: [{ filename: "out.png" }] } } } }) : bytesResponse("", 502), /下载 ComfyUI 输出失败/u);
});

test("ComfyUI rejects disabled, missing, and failed registered workflows without falling back", async () => {
  const workflow = { enabled: false, workflow: { "1": { class_type: "Text", inputs: { text: "" } } }, bindings: { prompt: { node: "1", input: "text" } }, defaults: {}, reference_slots: [], output_nodes: [] };
  const registry = { version: 1, workflows: { disabled: workflow } }; const connection = { baseUrl: "http://127.0.0.1:8188", timeoutMs: 1000, pollIntervalMs: 1 };
  const base = { prompt: "本地图", backend: "comfyui", count: 1, size: "512x512" };
  const missingRoot = await root(); const disabledRoot = await root(); const failedRoot = await root();
  await assert.rejects(() => createCandidates({ root: missingRoot, connection, registry, input: { ...base, workflow: "missing" } }), /NOT_CONFIGURED/u);
  await assert.rejects(() => createCandidates({ root: disabledRoot, connection, registry, input: { ...base, workflow: "disabled" } }), /NOT_ENABLED/u);
  const enabled = { version: 1, workflows: { failed: { ...workflow, enabled: true } } };
  const failedFetch = async (url) => {
    if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "failure" });
    return jsonResponse({ failure: { status: { status_str: "failed", messages: [["execution_error", {}]] }, outputs: {} } });
  };
  await assert.rejects(() => createCandidates({ root: failedRoot, connection, registry: enabled, input: { ...base, workflow: "failed" }, fetchImpl: failedFetch }), /执行失败/u);
});

test("API accepts a URL result and rejects a timed out request without a fallback", async () => {
  const target = await root(); const calls = [];
  const run = await createCandidates({ root: target, connection: api, input, fetchImpl: async (url) => { calls.push(url); return jsonResponse({ data: [{ url: "https://cdn.example.test/result.png" }] }); }, imageDownloader: async (url) => { calls.push(url); return png; } });
  assert.equal(run.status, "complete"); assert.deepEqual(calls, ["https://example.test/v1/images/generations", "https://cdn.example.test/result.png"]);
  const timeoutRoot = await root();
  await assert.rejects(() => createCandidates({ root: timeoutRoot, connection: { ...api, timeoutMs: 10 }, input, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort")))) }), /超时/u);
});

function streamedResponse({ statusCode = 200, headers = { "content-type": "image/png" }, chunks = [png] } = {}) { const body = Readable.from(chunks); body.statusCode = statusCode; body.headers = headers; return body; }
function transportFor(responses, state = {}) { return ({ onResponse }) => { queueMicrotask(() => onResponse(responses.shift())); return () => { state.aborted = true; }; }; }

test("URL downloads bind each hop to a resolved public IPv4 and reject unsafe or malformed responses", async () => {
  const resolver = async (host) => host === "cdn.example.test" ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(() => downloadImageUrl("http://127.0.0.1/a.png", { resolver }), /不安全/u);
  await assert.rejects(() => downloadImageUrl("https://localhost./a.png", { resolver }), /公网 IPv4/u);
  await assert.rejects(() => downloadImageUrl("https://[::1]/a.png", { resolver }), /公网 IPv4/u);
  await assert.rejects(() => downloadImageUrl("https://169.254.1.2/a.png", { resolver }), /公网 IPv4/u);
  await assert.rejects(() => downloadImageUrl("https://0.0.0.0/a.png", { resolver }), /公网 IPv4/u);
  await assert.rejects(() => downloadImageUrl("https://224.0.0.1/a.png", { resolver }), /公网 IPv4/u);
  assert.deepEqual(await downloadImageUrl("https://8.8.8.8/a.png", { resolver, transport: transportFor([streamedResponse()]) }), png);
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ statusCode: 302, headers: {} })]) }), /重定向无目标/u);
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ statusCode: 302, headers: { location: "http://127.0.0.1/a.png" } })]) }), /不安全/u);
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ statusCode: 502 })]) }), /HTTP 502/u);
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ headers: { "content-type": "text/html" }, chunks: [Buffer.from("not image")] })]) }), /不是图片/u);
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ headers: { "content-type": "image/png", "content-length": String(21 * 1024 * 1024) } })]) }), /超过大小限制/u);
});

test("redirects resolve each destination again instead of reusing an earlier DNS address", async () => {
  const seen = []; const resolver = async (host) => { seen.push(host); return host === "cdn.example.test" ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]; };
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ statusCode: 302, headers: { location: "https://changed.example.test/a.png" } })]) }), /公网 IPv4/u);
  assert.deepEqual(seen, ["cdn.example.test", "changed.example.test"]);
});

test("URL downloads stream with a body limit and cancel a slow body", async () => {
  const resolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const oversized = [Buffer.alloc(12 * 1024 * 1024), Buffer.alloc(12 * 1024 * 1024)];
  const oversizedState = {};
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { resolver, transport: transportFor([streamedResponse({ chunks: oversized })], oversizedState) }), /超过大小限制/u);
  assert.equal(oversizedState.aborted, true);
  const state = {}; const slow = new Readable({ read() {} }); slow.statusCode = 200; slow.headers = { "content-type": "image/png" };
  await assert.rejects(() => downloadImageUrl("https://cdn.example.test/a.png", { timeoutMs: 10, resolver, transport: transportFor([slow], state) }), /超时/u);
  assert.equal(state.aborted, true);
});

test("API rejects malformed and oversized Base64 results before writing a candidate", async () => {
  const target = await root(); const truncatedTarget = await root();
  await assert.rejects(() => createCandidates({ root: target, connection: api, input, fetchImpl: async () => jsonResponse({ data: [{ b64_json: "A".repeat(30 * 1024 * 1024) }] }) }), /(无效或过大|超过大小限制)/u);
  await assert.rejects(() => createCandidates({ root: truncatedTarget, connection: api, input, fetchImpl: async () => jsonResponse({ data: [{ b64_json: Buffer.from([137,80,78,71,13,10,26,10]).toString("base64") }] }) }), /完整有效/u);
});

test("API accepts a streamed Base64 JSON response large enough for a 20 MiB decoded image", async () => {
  const target = await root(); const image = structuralPng(20 * 1024 * 1024);
  const run = await createCandidates({ root: target, connection: api, input, fetchImpl: async () => jsonResponse({ data: [{ b64_json: image.toString("base64") }] }) });
  assert.equal(run.status, "complete"); assert.equal((await fs.stat(path.join(target, run.candidates[0].file))).size, image.length);
});
test("failed ledger callback preserves the completed candidate as a recoverable partial run", async () => {
  const target = await root();
  await assert.rejects(() => createCandidates({ root: target, connection: api, input, fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }), onSuccess: async () => { throw new Error("ledger unavailable"); } }), /ledger unavailable/u);
  const run = (await readRuns(target))[0]; assert.equal(run.status, "partial"); assert.equal(run.candidates.length, 1);
});
