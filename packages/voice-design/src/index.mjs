import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export const LANGUAGES = Object.freeze(["zh", "en", "de", "it", "pt", "es", "ja", "ko", "fr", "ru"]);
export const DEFAULT_VOICE_DESIGN_CONFIG = Object.freeze({
  baseUrl: "https://dashscope.aliyuncs.com/api/v1",
  designModel: "qwen-voice-design",
  targetModel: "qwen3-tts-vd-2026-01-26",
  namePrefix: "custom_voice",
  language: "zh",
  sampleRate: 24000,
  responseFormat: "wav",
});

export class VoiceDesignError extends Error {}

function clean(value) { return String(value ?? "").trim(); }
function compact(value, label, max = 160) { const result = clean(value); if (!result || result.length > max) throw new VoiceDesignError(label + " 无效。"); return result; }
function optionalCompact(value, fallback, label, max = 160) { return clean(value) ? compact(value, label, max) : fallback; }
function safeFormat(value) { const result = clean(value).toLowerCase(); if (!/^[a-z0-9]{2,12}$/u.test(result)) throw new VoiceDesignError("响应格式无效。"); return result; }
function safePrefix(value) { const result = clean(value).replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 16); return result || "custom_voice"; }
function safeRoot(root) { const result = path.resolve(clean(root)); if (!clean(root)) throw new VoiceDesignError("缺少音色数据目录。"); return result; }
function candidatePath(root, name) { const base = safeRoot(root); const target = path.resolve(base, name); if (path.dirname(target) !== base) throw new VoiceDesignError("候选文件路径无效。"); return target; }
const candidateMutationQueues = new Map();

function serializeCandidateMutation(root, task) {
  const key = safeRoot(root);
  const previous = candidateMutationQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  candidateMutationQueues.set(key, next);
  next.finally(() => {
    if (candidateMutationQueues.get(key) === next) candidateMutationQueues.delete(key);
  }).catch(() => undefined);
  return next;
}

function candidateName(value) { return compact(value, "音色名称", 80); }

function normalizeBrokenWavHeader(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 20) return audio;
  if (audio.subarray(0, 4).toString("ascii") !== "RIFF" || audio.subarray(8, 12).toString("ascii") !== "WAVE") return audio;
  let offset = 12;
  let dataOffset = -1;
  while (offset + 8 <= audio.length) {
    const chunkSize = audio.readUInt32LE(offset + 4);
    if (audio.subarray(offset, offset + 4).toString("ascii") === "data") { dataOffset = offset; break; }
    const nextOffset = offset + 8 + chunkSize + (chunkSize % 2);
    if (nextOffset > audio.length) return audio;
    offset = nextOffset;
  }
  if (dataOffset < 0) return audio;
  const actualRiffSize = audio.length - 8;
  const dataStart = dataOffset + 8;
  const actualDataSize = audio.length - dataStart;
  const declaredRiffSize = audio.readUInt32LE(4);
  const declaredDataSize = audio.readUInt32LE(dataOffset + 4);
  if (declaredRiffSize <= actualRiffSize && declaredDataSize <= actualDataSize) return audio;
  const normalized = Buffer.from(audio);
  normalized.writeUInt32LE(actualRiffSize, 4);
  normalized.writeUInt32LE(actualDataSize, dataOffset + 4);
  return normalized;
}

function normalizePreviewAudio(audio, responseFormat) {
  return safeFormat(responseFormat || "wav") === "wav" ? normalizeBrokenWavHeader(audio) : audio;
}

export function validateVoiceDesignConfig(value = {}) {
  const baseUrl = optionalCompact(value.baseUrl, DEFAULT_VOICE_DESIGN_CONFIG.baseUrl, "Base URL", 500).replace(/\/+$/u, "");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new VoiceDesignError("Base URL 必须是 HTTP(S) 地址。"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new VoiceDesignError("Base URL 必须是 HTTP(S) 地址。");
  return { baseUrl, ...validateVoiceDesignSettings(value) };
}

export function validateVoiceDesignSettings(value = {}) {
  const language = optionalCompact(value.language, DEFAULT_VOICE_DESIGN_CONFIG.language, "语言", 10);
  if (!LANGUAGES.includes(language)) throw new VoiceDesignError("不支持的声音语言。");
  const sampleRate = Number(value.sampleRate ?? DEFAULT_VOICE_DESIGN_CONFIG.sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) throw new VoiceDesignError("采样率必须在 8000 到 96000 之间。");
  return {
    designModel: optionalCompact(value.designModel, DEFAULT_VOICE_DESIGN_CONFIG.designModel, "设计模型"),
    targetModel: optionalCompact(value.targetModel, DEFAULT_VOICE_DESIGN_CONFIG.targetModel, "目标 TTS 模型"),
    namePrefix: safePrefix(value.namePrefix ?? DEFAULT_VOICE_DESIGN_CONFIG.namePrefix),
    language,
    sampleRate,
    responseFormat: safeFormat(value.responseFormat ?? DEFAULT_VOICE_DESIGN_CONFIG.responseFormat),
  };
}

export function validateVoiceDesignInput(value = {}) {
  const voicePrompt = clean(value.voicePrompt);
  const previewText = clean(value.previewText);
  const count = Number(value.count);
  if (!voicePrompt || voicePrompt.length > 2048) throw new VoiceDesignError("声音描述不能为空，且最多 2048 个字符。");
  if (!previewText || previewText.length > 1024) throw new VoiceDesignError("试听文本不能为空，且最多 1024 个字符。");
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new VoiceDesignError("候选数必须在 1 到 20 之间。");
  return { voicePrompt, previewText, count };
}

export function buildVoiceDesignRequest(config, input, preferredName) {
  const safeConfig = validateVoiceDesignConfig(config);
  const safeInput = validateVoiceDesignInput(input);
  return {
    endpoint: safeConfig.baseUrl + "/services/audio/tts/customization",
    payload: {
      model: safeConfig.designModel,
      input: {
        action: "create",
        target_model: safeConfig.targetModel,
        preferred_name: compact(preferredName, "名称", 80),
        voice_prompt: safeInput.voicePrompt,
        preview_text: safeInput.previewText,
        language: safeConfig.language,
      },
      parameters: {
        sample_rate: safeConfig.sampleRate,
        response_format: safeConfig.responseFormat,
      },
    },
  };
}

export function parseVoiceDesignResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VoiceDesignError("声音设计服务返回了无效响应。");
  if (clean(value.code)) throw new VoiceDesignError("声音设计服务失败：" + clean(value.code) + (clean(value.message) ? " " + clean(value.message).slice(0, 300) : ""));
  const output = value.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new VoiceDesignError("声音设计响应缺少 output。");
  const voiceId = clean(output.voice || output.voice_id);
  if (!voiceId) throw new VoiceDesignError("声音设计响应没有返回 voiceId。");
  const encoded = typeof output.preview_audio === "string" ? clean(output.preview_audio) : clean(output.preview_audio?.data);
  let previewAudio = null;
  if (encoded) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new VoiceDesignError("试听音频不是有效 Base64。");
    previewAudio = Buffer.from(encoded, "base64");
    if (!previewAudio.length) throw new VoiceDesignError("试听音频为空。");
  }
  return { voiceId, previewAudio, model: clean(value.model), requestId: clean(value.request_id || value.id), usage: value.usage && typeof value.usage === "object" && !Array.isArray(value.usage) ? value.usage : {} };
}

function publicCandidate(value) {
  return {
    id: clean(value.id),
    voiceId: clean(value.voiceId),
    displayName: clean(value.displayName),
    preferredName: clean(value.preferredName),
    targetModel: clean(value.targetModel),
    designModel: clean(value.designModel),
    language: clean(value.language),
    responseFormat: safeFormat(value.responseFormat || "wav"),
    previewPath: clean(value.previewPath || value.previewFile),
    voicePrompt: clean(value.voicePrompt),
    previewText: clean(value.previewText),
    createdAt: clean(value.createdAt),
    previewAvailable: Boolean(value.previewFile),
    retained: Boolean(clean(value.retainedAt)),
    retainedAt: clean(value.retainedAt),
  };
}

export async function readCandidates(root, { limit = 200 } = {}) {
  return (await readCandidateRecords(root)).slice(-limit).reverse().map(publicCandidate);
}

export async function readPreview(root, id) {
  const safeId = compact(id, "候选 ID", 100);
  const records = await readCandidateRecords(root);
  const record = records.find((item) => item.id === safeId);
  if (!record?.previewFile) return null;
  const filePath = candidatePath(root, record.previewFile);
  const audio = await fs.readFile(filePath);
  const responseFormat = safeFormat(record.responseFormat || "wav");
  return { data: normalizePreviewAudio(audio, responseFormat).toString("base64"), responseFormat };
}

async function readCandidateRecords(root) {
  const destination = candidatePath(root, "candidates.jsonl");
  const result = [];
  try {
    const input = readline.createInterface({ input: (await import("node:fs")).createReadStream(destination, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of input) {
      try { const value = JSON.parse(line); if (value?.id && value?.voiceId && value?.createdAt) result.push(value); } catch {}
    }
  } catch {}
  return result;
}

async function writeCandidateRecords(root, records) {
  const destination = candidatePath(root, "candidates.jsonl");
  const temporary = candidatePath(root, "candidates-" + randomUUID() + ".tmp");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(temporary, records.map((item) => JSON.stringify(item)).join("\n") + (records.length ? "\n" : ""), "utf8");
  await fs.rename(temporary, destination);
}

async function updateCandidate(root, id, update) {
  const safeId = compact(id, "候选 ID", 100);
  return serializeCandidateMutation(root, async () => {
    const records = await readCandidateRecords(root);
    const index = records.findIndex((item) => item.id === safeId);
    if (index < 0) throw new VoiceDesignError("找不到这个音色候选。");
    const next = update({ ...records[index] });
    records[index] = next;
    await writeCandidateRecords(root, records);
    return publicCandidate(next);
  });
}

export async function renameVoiceCandidate(root, { id, name } = {}) {
  const displayName = candidateName(name);
  return updateCandidate(root, id, (candidate) => ({ ...candidate, displayName, renamedAt: new Date().toISOString() }));
}

export async function retainVoiceCandidate(root, id) {
  return updateCandidate(root, id, (candidate) => ({ ...candidate, retainedAt: clean(candidate.retainedAt) || new Date().toISOString() }));
}

export async function deleteVoiceCandidate(root, id) {
  const safeId = compact(id, "候选 ID", 100);
  return serializeCandidateMutation(root, async () => {
    const records = await readCandidateRecords(root);
    const index = records.findIndex((item) => item.id === safeId);
    if (index < 0) throw new VoiceDesignError("找不到这个音色候选。");
    const [removed] = records.splice(index, 1);
    await writeCandidateRecords(root, records);

    // Only generated preview names are eligible for cleanup. A malformed local
    // record must never turn this action into deletion of another data file.
    const previewFile = clean(removed.previewFile);
    if (/^preview-[A-Za-z0-9_-]+\.[A-Za-z0-9]{2,12}$/u.test(previewFile)) {
      await fs.rm(candidatePath(root, previewFile), { force: true }).catch(() => undefined);
    }
    return publicCandidate(removed);
  });
}

export async function saveCandidate(root, { response, config, input, preferredName }) {
  const destinationRoot = safeRoot(root);
  const parsed = parseVoiceDesignResponse(response);
  const safeConfig = validateVoiceDesignConfig(config);
  const safeInput = validateVoiceDesignInput(input);
  const id = randomUUID();
  const previewFile = parsed.previewAudio ? "preview-" + id + "." + safeConfig.responseFormat : "";
  const record = {
    id,
    voiceId: parsed.voiceId,
    preferredName: compact(preferredName, "名称", 80),
    targetModel: safeConfig.targetModel,
    designModel: parsed.model || safeConfig.designModel,
    language: safeConfig.language,
    responseFormat: safeConfig.responseFormat,
    previewFile,
    previewPath: previewFile,
    voicePrompt: safeInput.voicePrompt,
    previewText: safeInput.previewText,
    previewCharacters: safeInput.previewText.length,
    createdAt: new Date().toISOString(),
    requestId: parsed.requestId,
  };
  await serializeCandidateMutation(destinationRoot, async () => {
    await fs.mkdir(destinationRoot, { recursive: true });
    const preview = parsed.previewAudio ? normalizePreviewAudio(parsed.previewAudio, safeConfig.responseFormat) : null;
    if (preview) await fs.writeFile(candidatePath(destinationRoot, previewFile), preview, { flag: "wx" });
    try {
      await fs.appendFile(candidatePath(destinationRoot, "candidates.jsonl"), JSON.stringify(record) + "\n", "utf8");
    } catch (error) {
      if (previewFile) await fs.rm(candidatePath(destinationRoot, previewFile), { force: true });
      throw error;
    }
  });
  return { candidate: publicCandidate(record), request: parsed };
}

export async function createVoiceCandidates({ root, config, input, apiKey, fetchImpl = fetch, onSuccess = async () => {}, timeoutMs = 90_000 }) {
  const safeConfig = validateVoiceDesignConfig(config);
  const safeInput = validateVoiceDesignInput(input);
  if (!clean(apiKey)) throw new VoiceDesignError("未配置 API Key。请保存加密 Key 或设置 DASHSCOPE_API_KEY。");
  if (typeof fetchImpl !== "function") throw new VoiceDesignError("当前环境无法发起声音设计请求。");
  const created = [];
  const batch = String(Date.now()).slice(-6);
  for (let index = 1; index <= safeInput.count; index += 1) {
    const preferredName = safeConfig.namePrefix.slice(0, 6) + "_" + batch + String(index).padStart(2, "0");
    const request = buildVoiceDesignRequest(safeConfig, safeInput, preferredName);
    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(request.endpoint, { method: "POST", headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify(request.payload), signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw new VoiceDesignError("声音设计请求超时（90 秒）。");
      throw new VoiceDesignError("无法连接声音设计服务。");
    } finally { clearTimeout(timer); }
    let body;
    try { body = await response.json(); } catch { throw new VoiceDesignError("声音设计服务返回的内容不是有效 JSON。"); }
    if (!response.ok) {
      const code = clean(body?.code) || String(response.status);
      throw new VoiceDesignError("声音设计服务请求失败：" + code + (clean(body?.message) ? " " + clean(body.message).slice(0, 300) : ""));
    }
    const saved = await saveCandidate(root, { response: body, config: safeConfig, input: safeInput, preferredName });
    await onSuccess({ ...saved, config: safeConfig, input: safeInput });
    created.push(saved.candidate);
  }
  return created;
}
