import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot, resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import {
  createCandidates,
  findCustomImageGenerationAdapter,
  ImageWorkbenchError,
  normalizeImageGenerationAdapter,
} from "@suzu-lives/image-workbench";
import { inspectImage } from "@suzu-lives/visual-reference-library";

export class AgentImageGenerationError extends Error {}

export const REFERENCE_ROLES = Object.freeze(["identity", "location", "object", "style"]);
const DEFAULT_CONFIG = Object.freeze({ adapter: "auto", customAdapterId: "", outputDirectory: "image-generation" });

function clean(value) { return String(value ?? "").trim(); }
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function requiredRoot(value, label) { const root = clean(value); if (!root) throw new AgentImageGenerationError(`缺少${label}。`); return path.resolve(root); }
function bounded(value, label, maximum) { const result = clean(value); if (!result || result.length > maximum) throw new AgentImageGenerationError(`${label}不能为空，且最多 ${maximum} 个字符。`); return result; }
function safeChild(root, raw, label, fallback = "", rootLabel = "当前 Agent 的 Suzu Lives 数据目录") { const base = path.resolve(root); const value = clean(raw || fallback); const target = path.resolve(base, value || "."); if (!inside(base, target)) throw new AgentImageGenerationError(`${label}必须位于${rootLabel}。`); return target; }
function capabilityConfigRoot(dataRoot) { return path.join(requiredRoot(dataRoot, "Suzu Lives 软件数据目录"), "capabilities", "image-generation"); }
function agentImageConfigPath({ dataRoot, configPath = "" } = {}) { const root = capabilityConfigRoot(dataRoot); return { root, path: configPath ? safeChild(root, configPath, "--config", "", "Suzu Lives 软件图像生成配置目录") : path.join(root, "config.json") }; }
function readJson(filePath, label) { return fs.readFile(filePath, "utf8").then((text) => { const value = JSON.parse(text); if (!plainObject(value)) throw new AgentImageGenerationError(`${label}必须是 JSON 对象。`); return value; }).catch((error) => { if (error instanceof AgentImageGenerationError) throw error; if (error instanceof SyntaxError) throw new AgentImageGenerationError(`${label}不是有效 JSON。`); if (error?.code === "ENOENT") throw new AgentImageGenerationError(`找不到${label}。`); throw new AgentImageGenerationError(`无法读取${label}：${error.message}`); }); }
function extensionMime(filePath) { return { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(filePath).toLowerCase()] || "image/png"; }

export function parseReference(value, index) {
  const source = clean(value); const separator = source.indexOf("="); const rawRole = separator < 0 ? "object" : source.slice(0, separator); const rawPath = separator < 0 ? source : source.slice(separator + 1); const role = clean(rawRole);
  if (!REFERENCE_ROLES.includes(role)) throw new AgentImageGenerationError(`--ref 角色必须是 identity、location、object 或 style：${role}`);
  if (!clean(rawPath)) throw new AgentImageGenerationError("--ref 缺少图片路径。 ");
  return { id: `cli-reference-${index}`, role, source: path.resolve(rawPath) };
}

export async function loadReferences(values = []) {
  const output = [];
  for (const [index, value] of values.entries()) {
    const reference = parseReference(value, index + 1); let inspected;
    try { inspected = await inspectImage(reference.source); } catch (error) { throw new AgentImageGenerationError(`参考图无效：${error.message}`); }
    output.push({ id: reference.id, role: reference.role, description: path.basename(inspected.source, inspected.extension), filename: path.basename(inspected.source), mime: extensionMime(inspected.source), data: await fs.readFile(inspected.source) });
  }
  return output;
}

export function parseImageGenerationArgs(values = []) {
  const result = { refs: [] }; const options = new Set(["prompt", "size", "ref", "out", "config", "data-root", "agent-id", "project-root"]);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index]; if (!token.startsWith("--")) throw new AgentImageGenerationError(`未知位置参数：${token}`); const key = token.slice(2); if (key === "send") throw new AgentImageGenerationError("图片生成不再支持 --send；生成完成后请使用当前 Suzu 会话提供的附件交付命令。 ");
    if (!options.has(key)) throw new AgentImageGenerationError(`未知选项：${token}`); const value = values[index + 1]; if (value === undefined || value.startsWith("--")) throw new AgentImageGenerationError(`${token} 缺少值。`); index += 1;
    if (key === "ref") { parseReference(value, result.refs.length + 1); result.refs.push(value); }
    else result[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!clean(result.prompt)) throw new AgentImageGenerationError("生成图片时必须填写 --prompt。 ");
  return result;
}

export function normalizeAgentImageConfig(value = {}) {
  const source = plainObject(value);
  const adapter = normalizeImageGenerationAdapter(source.adapter, { fallback: DEFAULT_CONFIG.adapter });
  const customAdapterId = adapter === "custom-http-image" ? clean(source.custom_adapter_id ?? source.customAdapterId).toLowerCase() : "";
  const output = plainObject(source.output); return { adapter, customAdapterId, outputDirectory: clean(output.directory ?? source.outputDirectory) || DEFAULT_CONFIG.outputDirectory };
}

export async function loadAgentImageConfig({ dataRoot, configPath = "" } = {}) {
  const target = agentImageConfigPath({ dataRoot, configPath }).path;
  try { return { config: normalizeAgentImageConfig(await readJson(target, "图像生成配置")), path: target, source: "saved" }; }
  catch (error) { if (error instanceof AgentImageGenerationError && error.message === "找不到图像生成配置。") return { config: normalizeAgentImageConfig(), path: target, source: "default" }; throw error; }
}

function usageEvent({ agentId, connection, item }) {
  return { agentId, provider: connection.provider || "OpenAI Compatible", model: item.result.model, source: "图片生成", feature: "image-" + item.result.mode, requestId: item.result.requestId, usage: item.result.usage, units: { imageRequests: 1, generatedImages: 1 }, metadata: { costSource: "provider-reported", size: item.input.size, referenceCount: item.referenceCount, backend: item.input.backend, protocol: clean(connection.imageGenerationAdapter), agentInvocation: true } };
}

async function selectedImageConnection(connectionResolver, context) {
  if (typeof connectionResolver !== "function") {
    throw new AgentImageGenerationError("图片生成必须由软件在 设置 → API 中选定的“生图”连接提供。 ");
  }
  const selected = await connectionResolver(context);
  const apiKey = clean(selected?.apiKey || selected?.key);
  if (!apiKey) {
    throw new AgentImageGenerationError("“生图”API 尚未配置可用 Key；请前往 设置 → API 重新选择或保存。 ");
  }
  return { ...plainObject(selected), apiKey, key: apiKey };
}

function configuredImageConnection({ connection, config, dataRoot }) {
  const selected = plainObject(connection);
  const adapter = config?.adapter || DEFAULT_CONFIG.adapter;
  const customImageGenerationAdapter = adapter === "custom-http-image"
    ? findCustomImageGenerationAdapter(dataRoot, config?.customAdapterId)
    : null;
  if (adapter === "custom-http-image" && !customImageGenerationAdapter) {
    throw new AgentImageGenerationError("请选择已保存的自定义图像协议。 ");
  }
  return {
    ...selected,
    imageGenerationAdapter: adapter,
    ...(customImageGenerationAdapter ? { customImageGenerationAdapter } : {}),
  };
}

export async function resolveImageGenerationApiConnection({ connection, dataRoot, configPath = "" } = {}) {
  const loaded = await loadAgentImageConfig({ dataRoot, configPath });
  return configuredImageConnection({ connection, config: loaded.config, dataRoot });
}

export async function runAgentImageGeneration({
  agentRoot,
  agentId = "",
  dataRoot,
  options = {},
  environment = process.env,
  fetchImpl = fetch,
  imageDownloader,
  connectionResolver,
  appendLedger = appendUsageEvent,
} = {}) {
  const root = requiredRoot(agentRoot, "当前 Agent 数据目录"); const prompt = bounded(options.prompt, "--prompt", 4000); const loaded = await loadAgentImageConfig({ dataRoot, configPath: options.config }); const backend = "api";
  const references = await loadReferences(options.refs || []); const outputRoot = safeChild(root, options.out || loaded.config.outputDirectory, "--out"); const connection = configuredImageConnection({
    connection: await selectedImageConnection(connectionResolver, { dataRoot, environment }),
    config: loaded.config,
    dataRoot,
  });
  const ledgerPath = path.join(root, "cost-ledger", "events.jsonl"); const run = await createCandidates({ root: outputRoot, connection, input: { prompt, backend, count: 1, size: clean(options.size) || "1024x1024" }, references, maxReferences: 16, fetchImpl, imageDownloader, onSuccess: async (item) => appendLedger(ledgerPath, usageEvent({ agentId, connection, item })) });
  const candidate = run.candidates[0]; const outputPath = path.join(outputRoot, candidate.file);
  return { status: "ok", backend, path: outputPath, sent: false, model: candidate.model, requestId: candidate.requestId || "", references: references.map(({ id, role }) => ({ id, role })), configSource: loaded.source };
}

export async function runAgentImageGenerationCli(values, dependencies = {}) {
  const options = parseImageGenerationArgs(values); const environment = dependencies.environment || process.env; const dataRoot = resolveSuzuLivesDataRoot({ configuredRoot: options.dataRoot || environment.SUZU_LIVES_DATA_ROOT, localAppData: environment.LOCALAPPDATA, appData: environment.APPDATA, fallbackBase: "", fallbackToLocatorWhenMissing: true }); const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: options.agentId || environment.SUZU_LIVES_AGENT_ID, projectRoot: options.projectRoot || environment.SUZU_LIVES_PROJECT_ROOT });
  try { return await runAgentImageGeneration({ ...dependencies, agentRoot, agentId: options.agentId || environment.SUZU_LIVES_AGENT_ID, dataRoot, options, environment }); } catch (error) { if (error instanceof AgentImageGenerationError || error instanceof ImageWorkbenchError) throw new AgentImageGenerationError(error.message); throw error; }
}
