import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";

export class ImageWorkbenchError extends Error {}
const ROLES = new Set(["identity", "location", "object", "style"]);
function clean(value) { return String(value ?? "").trim(); }
function safeRoot(value) { const result = path.resolve(clean(value)); if (!clean(value)) throw new ImageWorkbenchError("缺少候选数据目录。"); return result; }
function safeFile(root, name) { const target = path.resolve(safeRoot(root), name); if (path.dirname(target) !== safeRoot(root)) throw new ImageWorkbenchError("候选文件路径无效。"); return target; }
function json(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function imageExtension(data) { return data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? ".png" : data.subarray(0, 3).equals(Buffer.from([255,216,255])) ? ".jpg" : data.subarray(0, 4).equals(Buffer.from("RIFF")) ? ".webp" : ".png"; }
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 512 * 1024;
function validPng(data) { if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false; let offset = 8; let ihdr = false; let idat = false; while (offset < data.length) { if (offset + 12 > data.length) return false; const length = data.readUInt32BE(offset); const type = data.subarray(offset + 4, offset + 8).toString("ascii"); const end = offset + 12 + length; if (end > data.length) return false; if (!ihdr) { if (type !== "IHDR" || length !== 13 || data.readUInt32BE(offset + 8) === 0 || data.readUInt32BE(offset + 12) === 0) return false; ihdr = true; } if (type === "IDAT") idat = true; if (type === "IEND") return ihdr && idat && length === 0 && end === data.length; offset = end; } return false; }
function validJpeg(data) { if (data.length < 4 || data[0] !== 255 || data[1] !== 216) return false; let offset = 2; let sof = false; let scan = false; while (offset < data.length) { if (data[offset] !== 255) return false; while (data[offset] === 255) offset += 1; const marker = data[offset++]; if (marker === 217) return sof && scan && offset === data.length; if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) continue; if (offset + 2 > data.length) return false; const length = data.readUInt16BE(offset); if (length < 2 || offset + length > data.length) return false; if ((marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199) || (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207)) { if (length < 8 || data.readUInt16BE(offset + 3) === 0 || data.readUInt16BE(offset + 5) === 0) return false; sof = true; } if (marker === 218) { scan = true; offset += length; for (;;) { if (offset + 1 >= data.length) return false; if (data[offset] !== 255) { offset += 1; continue; } let next = offset + 1; while (data[next] === 255) next += 1; const code = data[next]; if (code === 0) { offset = next + 1; continue; } if (code >= 208 && code <= 215) { offset = next + 1; continue; } if (code === 217) return sof && offset + 2 === data.length; return false; } } offset += length; } return false; }
function validWebp(data) { if (data.length < 20 || !data.subarray(0, 4).equals(Buffer.from("RIFF")) || !data.subarray(8, 12).equals(Buffer.from("WEBP")) || data.readUInt32LE(4) + 8 !== data.length) return false; let offset = 12; let imageChunk = false; while (offset < data.length) { if (offset + 8 > data.length) return false; const type = data.subarray(offset, offset + 4).toString("ascii"); const length = data.readUInt32LE(offset + 4); const end = offset + 8 + length; if (end > data.length) return false; if (["VP8 ", "VP8L", "VP8X"].includes(type)) imageChunk = true; offset = end + (length % 2); } return imageChunk && offset === data.length; }
function ensureImage(data) { if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_IMAGE_BYTES) throw new ImageWorkbenchError("生成图片为空、截断或超过大小限制。"); if (!validPng(data) && !validJpeg(data) && !validWebp(data)) throw new ImageWorkbenchError("结果不是完整有效的 PNG、JPEG 或 WebP 图片。"); return data; }

export function validateInput(value = {}) {
  const prompt = clean(value.prompt);
  const backend = clean(value.backend);
  const count = Number(value.count);
  const size = clean(value.size || "1024x1024");
  if (!prompt || prompt.length > 4000) throw new ImageWorkbenchError("提示词不能为空，且最多 4000 个字符。");
  if (!["api", "comfyui"].includes(backend)) throw new ImageWorkbenchError("请选择 API 或 ComfyUI 后端。");
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new ImageWorkbenchError("候选数量必须在 1 到 20 之间。");
  if (!/^\d{2,5}x\d{2,5}$/iu.test(size)) throw new ImageWorkbenchError("图片尺寸必须是 WIDTHxHEIGHT。");
  return { prompt, backend, count, size, workflow: clean(value.workflow), seed: Number.isInteger(value.seed) ? value.seed : null, includeReferencePrompt: value.includeReferencePrompt !== false };
}
export function validateReferences(value = [], { maxReferences = 12 } = {}) {
  if (!Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 16) throw new ImageWorkbenchError("参考图数量上限无效。");
  if (!Array.isArray(value) || value.length > maxReferences) throw new ImageWorkbenchError("参考图数量无效。");
  return value.map((item) => {
    if (!ROLES.has(clean(item.role))) throw new ImageWorkbenchError("参考图角色无效。");
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data || "");
    ensureImage(data);
    return { id: clean(item.id), role: clean(item.role), description: clean(item.description).slice(0, 2000), filename: clean(item.filename).replace(/[^A-Za-z0-9._-]/gu, "_") || "reference.png", mime: clean(item.mime) || "image/png", data };
  });
}
export function promptWithReferenceRoles(prompt, references) {
  if (!references.length) return prompt;
  return prompt + "\n\nReference image roles (do not confuse their purposes):\n" + references.map((item, index) => "- Input image " + (index + 1) + ": role=" + item.role + "; label=" + (item.description || item.filename)).join("\n");
}
export function validateApiConnection(value = {}) {
  const baseUrl = clean(value.baseUrl).replace(/\/+$/u, "");
  if (!baseUrl) throw new ImageWorkbenchError("请先在 设置 → API 为“生图”选择并配置 API 地址。");
  let parsed; try { parsed = new URL(baseUrl); } catch { throw new ImageWorkbenchError("图像 API 地址必须是 HTTP(S) URL。"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new ImageWorkbenchError("图像 API 地址必须是 HTTP(S) URL。");
  const model = clean(value.model); if (!model) throw new ImageWorkbenchError("请配置图像模型。");
  const extraBody = json(value.extraBody); const editExtraBody = json(value.editExtraBody);
  return { baseUrl, model, provider: clean(value.provider) || "OpenAI Compatible", generationEndpoint: clean(value.generationEndpoint) || "/images/generations", editEndpoint: clean(value.editEndpoint) || "/images/edits", quality: clean(value.quality), outputFormat: clean(value.outputFormat), inputFidelity: clean(value.inputFidelity), extraBody, editExtraBody, timeoutMs: Math.min(600000, Math.max(1000, Number(value.timeoutMs) || 180000)) };
}
function endpoint(base, value) { return /^https?:\/\//iu.test(value) ? value : base + "/" + value.replace(/^\/+/, ""); }
function header(response, name) { return clean(response?.headers?.get?.(name) ?? response?.headers?.[name.toLowerCase()]); }
function responseOk(response) { const status = Number(response?.status ?? response?.statusCode); return response?.ok === true || (status >= 200 && status < 300); }
function checkedLength(response, maxBytes, label) { const value = header(response, "content-length"); if (value && (!/^\d+$/u.test(value) || Number(value) > maxBytes)) throw new ImageWorkbenchError(label + "超过大小限制。"); }
async function readBoundedBody(response, { timeoutMs, maxBytes, label, abort, setBodyAbort }) {
  const chunks = []; let size = 0;
  const controller = new AbortController(); let timer; let reader; const body = response?.body || (response?.[Symbol.asyncIterator] ? response : null);
  const cancel = () => { controller.abort(); reader?.cancel?.().catch?.(() => {}); body?.destroy?.(); body?.cancel?.().catch?.(() => {}); abort?.(); };
  const append = (value) => { const chunk = Buffer.from(value); size += chunk.length; if (size > maxBytes) { cancel(); throw new ImageWorkbenchError(label + "超过大小限制。"); } chunks.push(chunk); };
  setBodyAbort?.(cancel);
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(new ImageWorkbenchError(label + "超时。")); }, timeoutMs); });
  const read = async () => {
    if (body?.getReader) { reader = body.getReader(); controller.signal.addEventListener("abort", () => reader.cancel().catch(() => {}), { once: true }); for (;;) { const item = await reader.read(); if (item.done) break; append(item.value); } }
    else if (body?.[Symbol.asyncIterator]) { controller.signal.addEventListener("abort", () => body.destroy?.(), { once: true }); for await (const chunk of body) append(chunk); }
    else if (typeof response?.arrayBuffer === "function") append(await response.arrayBuffer());
    else throw new ImageWorkbenchError(label + "没有可读取响应体。");
    return Buffer.concat(chunks);
  };
  try { checkedLength(response, maxBytes, label); return await Promise.race([read(), timeout]); } catch (error) { cancel(); throw error; } finally { clearTimeout(timer); }
}
async function boundedFetch(fetchImpl, target, options, timeoutMs, label, consume) {
  const controller = new AbortController(); let timer; let abortBody = () => {};
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); abortBody(); reject(new ImageWorkbenchError(label + "超时。")); }, timeoutMs); });
  try { const response = await Promise.race([fetchImpl(target, { ...options, signal: controller.signal }), timeout]); return consume ? await Promise.race([consume(response, () => controller.abort(), (callback) => { abortBody = callback; }), timeout]) : response; }
  catch (error) { if (error instanceof ImageWorkbenchError) throw error; throw new ImageWorkbenchError(controller.signal.aborted ? label + "超时。" : label + "失败。"); }
  finally { clearTimeout(timer); }
}
async function responseJson(fetchImpl, target, options, timeoutMs, label, maxBytes = MAX_JSON_BYTES, readErrorBody = true) {
  return boundedFetch(fetchImpl, target, options, timeoutMs, label, async (response, abort, setBodyAbort) => {
    if (!responseOk(response) && !readErrorBody) { abort(); return { response, payload: {} }; }
    let body; let payload; try { body = await readBoundedBody(response, { timeoutMs, maxBytes, label, abort, setBodyAbort }); payload = JSON.parse(body.toString("utf8")); } catch (error) { if (error instanceof ImageWorkbenchError) throw error; abort(); throw new ImageWorkbenchError(label + "返回无效数据。"); }
    if (!responseOk(response)) abort();
    return { response, payload, bodyBytes: body.length };
  });
}
function normalizedIp(value) { return clean(value).replace(/^\[|\]$/gu, ""); }
function publicIpv4(value) {
  if (net.isIP(value) !== 4) return false; const [a, b] = value.split(".").map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a !== 169 && !(a === 100 && b >= 64 && b <= 127) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168)) && !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0) && a < 224;
}
function publicIpv6(value) {
  const address = normalizedIp(value).toLowerCase();
  if (net.isIP(address) !== 6) return false;
  const firstGroup = Number.parseInt(address.split(":")[0], 16);
  return Number.isInteger(firstGroup) && firstGroup >= 0x2000 && firstGroup <= 0x3fff;
}
function publicAddress(value) {
  const address = normalizedIp(typeof value === "string" ? value : value?.address);
  const family = net.isIP(address);
  return (family === 4 && publicIpv4(address)) || (family === 6 && publicIpv6(address)) ? { address, family } : null;
}
function dashscopeResultHost(value) { return /(?:^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/u.test(normalizedIp(value).toLowerCase()); }
function dashscopeResultProxyAddress(value) {
  const address = normalizedIp(typeof value === "string" ? value : value?.address);
  const family = net.isIP(address);
  const [first, second] = address.split(".").map(Number);
  return family === 4 && first === 198 && second >= 18 && second <= 19 ? { address, family } : null;
}
async function resolvePublicAddress(host, resolver) {
  const normalizedHost = normalizedIp(host);
  const family = net.isIP(normalizedHost);
  const records = family ? [{ address: normalizedHost, family }] : await resolver(normalizedHost);
  const values = Array.isArray(records) ? records : [records];
  const address = values.map(publicAddress).find(Boolean) || (dashscopeResultHost(normalizedHost) ? values.map(dashscopeResultProxyAddress).find(Boolean) : null);
  if (!address) throw new ImageWorkbenchError("图像 API 返回的 URL 没有可用的公网 IPv4 地址。");
  return address;
}
function nodeTransport({ target, address, onResponse, onError }) {
  const targetAddress = normalizedIp(target.hostname);
  const request = https.request({ protocol: "https:", hostname: target.hostname, port: target.port || 443, path: target.pathname + target.search, method: "GET", headers: { Accept: "image/*", Host: target.host }, servername: net.isIP(targetAddress) ? undefined : target.hostname, lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family) }, onResponse);
  request.once("error", onError); request.end(); return () => request.destroy();
}
async function requestImage(target, address, transport, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false; let abort = () => {}; const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { abort(); finish(reject, new ImageWorkbenchError("下载图像结果超时。")); }, timeoutMs);
    try { abort = transport({ target, address, onResponse: (response) => finish(resolve, { response, abort }), onError: () => finish(reject, new ImageWorkbenchError("下载图像结果失败。")) }) || abort; } catch { finish(reject, new ImageWorkbenchError("下载图像结果失败。")); }
  });
}
export async function downloadImageUrl(rawUrl, { timeoutMs = 180000, resolver = (host) => dns.lookup(host, { all: true, verbatim: true }), transport = nodeTransport } = {}) {
  let target; try { target = new URL(clean(rawUrl)); } catch { throw new ImageWorkbenchError("图像 API 没有返回可下载图片。"); }
  for (let hops = 0; hops < 4; hops += 1) {
    if (target.protocol !== "https:" || target.username || target.password) throw new ImageWorkbenchError("图像 API 返回了不安全的图片 URL。");
    const address = await resolvePublicAddress(target.hostname, resolver).catch((error) => { if (error instanceof ImageWorkbenchError) throw error; throw new ImageWorkbenchError("图像 API 返回的 URL 无法安全解析。"); });
    const { response, abort } = await requestImage(target, address, transport, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(Number(response.statusCode ?? response.status))) { const location = header(response, "location"); abort(); if (!location) throw new ImageWorkbenchError("下载图像结果重定向无目标。"); try { target = new URL(location, target); } catch { throw new ImageWorkbenchError("下载图像结果重定向无目标。"); } continue; }
    if (!responseOk(response)) { abort(); throw new ImageWorkbenchError("下载图像结果失败：HTTP " + Number(response.statusCode ?? response.status)); }
    const type = header(response, "content-type").toLowerCase(); if (type && !type.startsWith("image/")) { abort(); throw new ImageWorkbenchError("下载图像结果不是图片类型。"); }
    return ensureImage(await readBoundedBody(response, { timeoutMs, maxBytes: MAX_IMAGE_BYTES, label: "下载图像结果", abort }));
  }
  throw new ImageWorkbenchError("下载图像结果重定向过多。");
}
async function responseImage(item, timeoutMs, imageDownloader) { const raw = clean(item?.b64_json || item?.b64 || item?.image_base64); if (raw) { if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) throw new ImageWorkbenchError("图像 API 返回了无效或过大的 Base64 图片。"); return ensureImage(Buffer.from(raw, "base64")); } return imageDownloader(clean(item?.url), { timeoutMs }); }

const DASHSCOPE_IMAGE_ENDPOINT = "/services/aigc/multimodal-generation/generation";

function dashscopeImageConnection(value = {}) {
  const baseUrl = clean(value.baseUrl).replace(/\/+$/u, "");
  if (!baseUrl) throw new ImageWorkbenchError("请先在 设置 → API 为“生图”选择并配置阿里百炼连接。 ");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new ImageWorkbenchError("阿里百炼地址必须是 HTTP(S) URL。 "); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new ImageWorkbenchError("阿里百炼地址必须是 HTTP(S) URL。 ");
  return { baseUrl, timeoutMs: Math.min(600000, Math.max(1000, Number(value.timeoutMs) || 180000)) };
}

function dashscopeReferenceDataUrl(reference) {
  return `data:${reference.mime};base64,${reference.data.toString("base64")}`;
}

function dashscopeImageUrl(payload) {
  const content = payload?.output?.choices?.[0]?.message?.content;
  const item = Array.isArray(content) ? content.find((value) => clean(value?.image)) : null;
  const url = clean(item?.image);
  if (!url) throw new ImageWorkbenchError("阿里百炼没有返回可下载图片。 ");
  return url;
}

async function dashscopeImage({ connection, input, references, fetchImpl, imageDownloader }) {
  const config = dashscopeImageConnection(connection);
  if (references.length > 9) throw new ImageWorkbenchError("带参考图的阿里百炼生成最多支持 9 张参考图。 ");
  const prompt = input.includeReferencePrompt ? promptWithReferenceRoles(input.prompt, references) : input.prompt;
  const withReferences = references.length > 0;
  const selectedModel = clean(connection.model);
  const body = withReferences
    ? {
      model: selectedModel || "wan2.7-image",
      input: { messages: [{ role: "user", content: [...references.map((reference) => ({ image: dashscopeReferenceDataUrl(reference) })), { text: prompt }] }] },
      parameters: { size: "2K", n: 1, watermark: false },
    }
    : {
      model: selectedModel || "z-image-turbo",
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { prompt_extend: false, size: input.size.replace("x", "*") },
    };
  const { response, payload } = await responseJson(fetchImpl, endpoint(config.baseUrl, DASHSCOPE_IMAGE_ENDPOINT), {
    method: "POST",
    headers: { Authorization: "Bearer " + clean(connection.apiKey), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, config.timeoutMs, "阿里百炼图像请求", MAX_IMAGE_JSON_BYTES);
  if (!responseOk(response)) throw new ImageWorkbenchError("阿里百炼图像请求失败：" + clean(payload?.code || payload?.message || payload?.error?.message || response.status).slice(0, 500));
  return {
    image: await imageDownloader(dashscopeImageUrl(payload), { timeoutMs: config.timeoutMs }),
    model: body.model,
    requestId: clean(payload?.request_id),
    usage: json(payload?.usage),
    mode: withReferences ? "edit" : "generation",
  };
}

async function apiImage({ connection, input, references, fetchImpl, imageDownloader }) {
  const config = validateApiConnection(connection);
  const fields = { model: config.model, prompt: input.includeReferencePrompt ? promptWithReferenceRoles(input.prompt, references) : input.prompt, n: 1, size: input.size };
  if (config.quality) fields.quality = config.quality;
  if (config.outputFormat) fields.output_format = config.outputFormat;
  const headers = { Authorization: "Bearer " + clean(connection.apiKey), Accept: "application/json" };
  let body; let target;
  if (references.length) {
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...config.editExtraBody, ...fields })) form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    if (config.inputFidelity) form.append("input_fidelity", config.inputFidelity);
    for (const reference of references) form.append("image[]", new Blob([reference.data], { type: reference.mime }), reference.filename);
    body = form; target = endpoint(config.baseUrl, config.editEndpoint);
  } else { body = JSON.stringify({ ...config.extraBody, ...fields }); headers["Content-Type"] = "application/json"; target = endpoint(config.baseUrl, config.generationEndpoint); }
  const { response, payload, bodyBytes } = await responseJson(fetchImpl, target, { method: "POST", headers, body }, config.timeoutMs, "图像 API 请求", MAX_IMAGE_JSON_BYTES);
  if (!responseOk(response)) throw new ImageWorkbenchError("图像 API 请求失败：" + clean(payload?.error?.message || payload?.message || response.status).slice(0, 500));
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!clean(item?.b64_json || item?.b64 || item?.image_base64) && bodyBytes > MAX_JSON_BYTES) throw new ImageWorkbenchError("图像 API 的 URL 或普通 JSON 响应超过大小限制。");
  return { image: await responseImage(item, config.timeoutMs, imageDownloader), model: clean(payload?.model) || config.model, requestId: clean(payload?.request_id || payload?.id), usage: json(payload?.usage), mode: references.length ? "edit" : "generation" };
}
export function validateComfyRegistry(value = {}) {
  if (value.version !== 1 || !json(value.workflows)) throw new ImageWorkbenchError("ComfyUI registry 必须包含 version: 1 和 workflows 对象。");
  const workflows = {};
  for (const [id, raw] of Object.entries(value.workflows)) {
    const entry = json(raw); const workflow = json(entry.workflow); const bindings = json(entry.bindings);
    if (!/^[a-z0-9][a-z0-9._-]{0,120}$/iu.test(id) || !Object.keys(workflow).length || Array.isArray(workflow.nodes) || !json(bindings.prompt)) throw new ImageWorkbenchError("ComfyUI 工作流注册格式无效：" + id);
    for (const node of Object.values(workflow)) if (!json(node).class_type || !json(node).inputs) throw new ImageWorkbenchError("ComfyUI 工作流必须是 API Format：" + id);
    const validateBinding = (binding, label) => { const node = clean(binding?.node); const input = clean(binding?.input); if (!node || !input || !json(workflow[node]).inputs || !Object.hasOwn(workflow[node].inputs, input)) throw new ImageWorkbenchError("ComfyUI " + label + " 未映射到真实节点输入：" + id); return { node, input }; };
    const normalizedBindings = {}; for (const [name, binding] of Object.entries(bindings)) normalizedBindings[name] = validateBinding(binding, "binding " + name);
    const defaults = json(entry.defaults); for (const name of Object.keys(defaults)) if (!normalizedBindings[name]) throw new ImageWorkbenchError("ComfyUI defaults 缺少对应 binding：" + id);
    if (!Array.isArray(entry.reference_slots) || !Array.isArray(entry.output_nodes)) throw new ImageWorkbenchError("ComfyUI reference_slots 与 output_nodes 必须是数组：" + id);
    const referenceSlots = entry.reference_slots.map((slot, index) => { if (!json(slot) || !Array.isArray(slot.roles) || !slot.roles.every((role) => ROLES.has(clean(role))) || typeof slot.required !== "boolean") throw new ImageWorkbenchError("ComfyUI reference slot 无效：" + id); return { ...validateBinding(slot, "reference slot " + index), roles: slot.roles.map(clean), required: slot.required }; });
    const outputNodes = entry.output_nodes.map(clean); if (outputNodes.some((node) => !workflow[node])) throw new ImageWorkbenchError("ComfyUI output_nodes 不存在：" + id);
    workflows[id] = { id, enabled: entry.enabled === true, description: clean(entry.description), workflow, bindings: normalizedBindings, defaults, referenceSlots, outputNodes };
  }
  return { version: 1, workflows };
}
function setBinding(workflow, binding, value) { const node = clean(binding?.node); const input = clean(binding?.input); if (!node || !input || !json(workflow[node]).inputs || !Object.hasOwn(workflow[node].inputs, input)) throw new ImageWorkbenchError("ComfyUI binding 无效。"); workflow[node].inputs[input] = value; }
async function uploadComfyReference(server, reference, fetchImpl, subfolder, timeoutMs) { const form = new FormData(); form.append("image", new Blob([reference.data], { type: reference.mime }), reference.filename); form.append("type", "input"); form.append("subfolder", subfolder); form.append("overwrite", "true"); const { response, payload: result } = await responseJson(fetchImpl, server + "/upload/image", { method: "POST", body: form }, timeoutMs, "ComfyUI 上传参考图"); const name = clean(result?.name); if (!responseOk(response) || !name) throw new ImageWorkbenchError("ComfyUI 上传参考图失败。"); return clean(result.subfolder) ? clean(result.subfolder) + "/" + name : name; }
async function comfyImage({ connection, input, references, registry, fetchImpl }) {
  const server = clean(connection.baseUrl).replace(/\/+$/u, ""); if (!server) throw new ImageWorkbenchError("请先配置 ComfyUI 地址。");
  const all = validateComfyRegistry(registry).workflows; const entry = all[input.workflow]; if (!entry) throw new ImageWorkbenchError("COMFYUI_WORKFLOW_NOT_CONFIGURED：未找到已注册工作流。"); if (!entry.enabled) throw new ImageWorkbenchError("COMFYUI_WORKFLOW_NOT_ENABLED：" + entry.id);
  const workflow = structuredClone(entry.workflow); for (const [name, value] of Object.entries(entry.defaults)) setBinding(workflow, entry.bindings[name], value); setBinding(workflow, entry.bindings.prompt, input.includeReferencePrompt ? promptWithReferenceRoles(input.prompt, references) : input.prompt);
  const seed = input.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER); if (entry.bindings.seed) setBinding(workflow, entry.bindings.seed, seed);
  const [width, height] = input.size.split("x").map(Number); if (entry.bindings.width) setBinding(workflow, entry.bindings.width, width); if (entry.bindings.height) setBinding(workflow, entry.bindings.height, height);
  const timeoutMs = Math.min(600000, Math.max(1000, Number(connection.timeoutMs) || 600000)); const pollIntervalMs = Math.min(30000, Math.max(100, Number(connection.pollIntervalMs) || 1000)); const unused = [...references]; const subfolder = "suzu-lives/" + randomUUID();
  for (const slot of entry.referenceSlots) { const allowed = slot.roles; const index = unused.findIndex((item) => !allowed.length || allowed.includes(item.role)); if (index < 0) { if (slot.required) throw new ImageWorkbenchError("ComfyUI 工作流缺少必需参考图。"); continue; } const reference = unused.splice(index, 1)[0]; setBinding(workflow, slot, await uploadComfyReference(server, reference, fetchImpl, subfolder, Math.min(timeoutMs, 120000))); }
  if (unused.length) throw new ImageWorkbenchError("当前已注册 ComfyUI 工作流没有足够的参考图输入槽。");
  const { response: submit, payload: submitted } = await responseJson(fetchImpl, server + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }) }, Math.min(timeoutMs, 120000), "ComfyUI 提交工作流"); const promptId = clean(submitted.prompt_id); if (!responseOk(submit) || !promptId) throw new ImageWorkbenchError("ComfyUI 拒绝工作流：" + JSON.stringify(submitted.node_errors || submitted).slice(0, 500));
  const deadline = Date.now() + timeoutMs; let output;
  while (Date.now() < deadline) { const { response, payload: history } = await responseJson(fetchImpl, server + "/history/" + encodeURIComponent(promptId), {}, Math.min(timeoutMs, 30000), "ComfyUI 查询任务", 5 * MAX_JSON_BYTES, false); if (!responseOk(response)) throw new ImageWorkbenchError("ComfyUI 查询任务失败：HTTP " + response.status); const run = json(history[promptId]); const status = json(run.status); const messages = Array.isArray(status.messages) ? status.messages : []; const failed = ["error", "failed", "cancelled", "canceled"].includes(clean(status.status_str).toLowerCase()) || messages.some((item) => Array.isArray(item) && clean(item[0]).toLowerCase() === "execution_error"); if (failed) throw new ImageWorkbenchError("ComfyUI 工作流执行失败：" + JSON.stringify(messages).slice(0, 500)); const nodes = entry.outputNodes.length ? entry.outputNodes : Object.keys(json(run.outputs)); for (const id of nodes) { const image = json(run.outputs)[id]?.images?.[0]; if (image) { output = image; break; } } if (output) break; if (status.completed) throw new ImageWorkbenchError("ComfyUI 工作流结束但没有图片输出。"); await new Promise((resolve) => setTimeout(resolve, pollIntervalMs)); }
  if (!output) throw new ImageWorkbenchError("ComfyUI 工作流等待超时或没有图片输出。");
  const query = new URLSearchParams({ filename: clean(output.filename), subfolder: clean(output.subfolder), type: clean(output.type) || "output" }); const image = await boundedFetch(fetchImpl, server + "/view?" + query, {}, Math.min(timeoutMs, 120000), "下载 ComfyUI 输出", async (view, abort, setBodyAbort) => { if (!responseOk(view)) { abort(); throw new ImageWorkbenchError("下载 ComfyUI 输出失败：HTTP " + view.status); } const type = header(view, "content-type").toLowerCase(); if (type && !type.startsWith("image/")) { abort(); throw new ImageWorkbenchError("下载 ComfyUI 输出不是图片类型。"); } return ensureImage(await readBoundedBody(view, { timeoutMs: Math.min(timeoutMs, 120000), maxBytes: MAX_IMAGE_BYTES, label: "下载 ComfyUI 输出", abort, setBodyAbort })); }); return { image, model: "ComfyUI / " + entry.id, requestId: promptId, usage: {}, mode: "workflow", seed, workflow: entry.id };
}
async function writeRun(root, record) { await fs.mkdir(safeRoot(root), { recursive: true }); await fs.appendFile(safeFile(root, "runs.jsonl"), JSON.stringify(record) + "\n", "utf8"); }
export async function createCandidates({ root, connection, registry, input: rawInput, references: rawReferences = [], maxReferences = 12, fetchImpl = fetch, imageDownloader = downloadImageUrl, onSuccess = async () => {} }) {
  const input = validateInput(rawInput); const references = validateReferences(rawReferences, { maxReferences }); if (!clean(connection?.apiKey) && input.backend === "api") throw new ImageWorkbenchError("请先在 设置 → API 为“生图”选择并配置 API。 ");
  const runId = randomUUID(); const record = { id: runId, createdAt: new Date().toISOString(), prompt: input.prompt, backend: input.backend, workflow: input.workflow, size: input.size, countRequested: input.count, references: references.map(({ id, role, description, filename }) => ({ id, role, description, filename })), candidates: [], status: "running", note: "人工候选批次；尚未写入视觉参考库。" }; await writeRun(root, record);
  try { for (let index = 0; index < input.count; index += 1) { const result = input.backend === "api" ? (clean(connection?.type).toLowerCase() === "dashscope" ? await dashscopeImage({ connection, input, references, fetchImpl, imageDownloader }) : await apiImage({ connection, input, references, fetchImpl, imageDownloader })) : await comfyImage({ connection, input: { ...input, seed: input.seed === null ? null : input.seed + index }, references, registry, fetchImpl }); const name = "candidate-" + runId + "-" + String(index + 1).padStart(2, "0") + imageExtension(result.image); await fs.writeFile(safeFile(root, name), result.image, { flag: "wx" }); const candidate = { id: runId + "-" + (index + 1), file: name, backend: input.backend, model: result.model, requestId: result.requestId, seed: result.seed ?? null, mode: result.mode, workflow: result.workflow || "", createdAt: new Date().toISOString() }; record.candidates.push(candidate); await onSuccess({ candidate, result, input, referenceCount: references.length }); } record.status = "complete"; }
  catch (error) { record.status = record.candidates.length ? "partial" : "failed"; record.error = error?.message || String(error); throw error; }
  finally { await writeRun(root, record); }
  return record;
}
export async function readRuns(root, { limit = 50 } = {}) { const values = []; try { const text = await fs.readFile(safeFile(root, "runs.jsonl"), "utf8"); for (const line of text.split(/\r?\n/u)) try { const value = JSON.parse(line); if (value?.id && value?.createdAt && Array.isArray(value.candidates)) values.push(value); } catch {} } catch {} return values.filter((value) => value.status !== "running").slice(-limit).reverse(); }
export async function readCandidate(root, runId, candidateId) { const run = (await readRuns(root, { limit: 500 })).find((item) => item.id === clean(runId)); const candidate = run?.candidates.find((item) => item.id === clean(candidateId)); if (!candidate) return null; return fs.readFile(safeFile(root, candidate.file)); }
