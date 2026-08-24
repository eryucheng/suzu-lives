import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCandidates, downloadImageUrl, readRuns } from "../src/index.mjs";

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

test("selected image protocol controls the cloud request format", async () => {
  let target = "";
  let request;
  const run = await createCandidates({
    root: await root(),
    connection: {
      apiKey: credential(),
      baseUrl: "https://dashscope.example.test/api/v1",
      imageGenerationAdapter: "dashscope-image",
      model: "selected-dashscope-model",
      type: "generic-api",
    },
    input,
    fetchImpl: async (url, options) => {
      target = url;
      request = JSON.parse(options.body);
      return jsonResponse({
        request_id: "selected-protocol-request",
        output: { choices: [{ message: { content: [{ image: "https://cdn.example.test/image.png" }] } }] },
      });
    },
    imageDownloader: async () => png,
  });
  assert.equal(target.endsWith("/services/aigc/multimodal-generation/generation"), true);
  assert.equal(request.model, "selected-dashscope-model");
  assert.equal(run.candidates[0].requestId, "selected-protocol-request");
});

test("custom image protocol resolves its saved request template and image result", async () => {
  let target = "";
  let request;
  const run = await createCandidates({
    root: await root(),
    connection: {
      apiKey: credential(),
      customImageGenerationAdapter: {
        baseUrl: "https://custom.example.test",
        endpointPath: "/draw",
        imagePath: "result.url",
        requestBody: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size}}" },
        requestHeaders: { Authorization: "Bearer {{apiKey}}" },
        responseMode: "json-url",
      },
      imageGenerationAdapter: "custom-http-image",
      model: "custom-image-model",
      type: "generic-api",
    },
    input,
    fetchImpl: async (url, options) => {
      target = url;
      request = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, "Bearer " + credential());
      return jsonResponse({ result: { url: "https://cdn.example.test/custom.png" } });
    },
    imageDownloader: async () => png,
  });
  assert.equal(target, "https://custom.example.test/draw");
  assert.deepEqual(request, { model: "custom-image-model", prompt: "一幅测试图", size: "1024x1024" });
  assert.equal(run.candidates[0].model, "custom-image-model");
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

test("API accepts a URL result and rejects a timed out request without a fallback", async () => {
  const target = await root(); const calls = [];
  const run = await createCandidates({ root: target, connection: api, input, fetchImpl: async (url) => { calls.push(url); return jsonResponse({ data: [{ url: "https://cdn.example.test/result.png" }] }); }, imageDownloader: async (url) => { calls.push(url); return png; } });
  assert.equal(run.status, "complete"); assert.deepEqual(calls, ["https://example.test/v1/images/generations", "https://cdn.example.test/result.png"]);
  const timeoutRoot = await root();
  await assert.rejects(() => createCandidates({ root: timeoutRoot, connection: { ...api, timeoutMs: 10 }, input, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort")))) }), /超时/u);
});

test("API reports safe diagnostics for non-JSON service responses", async () => {
  const htmlRoot = await root(); const binaryRoot = await root(); const oversizedRoot = await root();
  await assert.rejects(
    () => createCandidates({
      root: htmlRoot,
      connection: api,
      input,
      fetchImpl: async () => new Response("<html><body><h1>Missing image route</h1><p>Authorization: Bearer secret-token-value</p></body></html>", { status: 404, headers: { "content-type": "text/html" } }),
    }),
    (error) => {
      assert.match(error.message, /图像 API 请求失败（HTTP 404，响应类型 text\/html）/u);
      assert.match(error.message, /Missing image route/u);
      assert.doesNotMatch(error.message, /secret-token-value/u);
      return true;
    },
  );
  await assert.rejects(
    () => createCandidates({ root: binaryRoot, connection: api, input, fetchImpl: async () => bytesResponse(png) }),
    /图像 API 请求返回了非 JSON 数据（HTTP 200，响应类型 image\/png）。/u,
  );
  await assert.rejects(
    () => createCandidates({ root: oversizedRoot, connection: api, input, fetchImpl: async () => new Response("x".repeat(20 * 1024), { status: 502, headers: { "content-type": "text/html" } }) }),
    /响应正文超过 16 KB，已停止读取/u,
  );
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
