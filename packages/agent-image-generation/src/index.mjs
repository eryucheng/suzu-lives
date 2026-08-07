import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot, resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { createCandidates, ImageWorkbenchError, validateComfyRegistry } from "@suzu-lives/image-workbench";
import { asDashScopeImageConnection, createDashScopeConnectionService } from "@suzu-lives/service-connections";
import { inspectImage } from "@suzu-lives/visual-reference-library";

export class AgentImageGenerationError extends Error {}

export const REFERENCE_ROLES = Object.freeze(["identity", "location", "object", "style"]);
const DEFAULT_CONFIG = Object.freeze({ defaultBackend: "api", outputDirectory: "image-generation", comfyui: { baseUrl: "http://127.0.0.1:8188", timeoutMs: 600000, pollIntervalMs: 1000, registry: "workflows/registry.json", defaultWorkflow: "" } });

function clean(value) { return String(value ?? "").trim(); }
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function requiredRoot(value, label) { const root = clean(value); if (!root) throw new AgentImageGenerationError(`缺少${label}。`); return path.resolve(root); }
function bounded(value, label, maximum) { const result = clean(value); if (!result || result.length > maximum) throw new AgentImageGenerationError(`${label}不能为空，且最多 ${maximum} 个字符。`); return result; }
function safeChild(root, raw, label, fallback = "") { const base = path.resolve(root); const value = clean(raw || fallback); const target = path.resolve(base, value || "."); if (!inside(base, target)) throw new AgentImageGenerationError(`${label}必须位于当前 Agent 的 Suzu Lives 数据目录。`); return target; }
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
  const result = { refs: [] }; const flags = new Set(["list-workflows", "validate-workflows"]); const options = new Set(["prompt", "backend", "workflow", "size", "seed", "ref", "out", "config", "data-root", "agent-id", "project-root"]);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index]; if (!token.startsWith("--")) throw new AgentImageGenerationError(`未知位置参数：${token}`); const key = token.slice(2); if (key === "send") throw new AgentImageGenerationError("图片生成不再支持 --send；生成完成后请使用当前 Suzu 会话提供的附件交付命令。 ");
    if (flags.has(key)) { result[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = true; continue; }
    if (!options.has(key)) throw new AgentImageGenerationError(`未知选项：${token}`); const value = values[index + 1]; if (value === undefined || value.startsWith("--")) throw new AgentImageGenerationError(`${token} 缺少值。`); index += 1;
    if (key === "ref") { parseReference(value, result.refs.length + 1); result.refs.push(value); }
    else if (key === "seed") { const seed = Number(value); if (!Number.isInteger(seed)) throw new AgentImageGenerationError("--seed 必须是整数。 "); result.seed = seed; }
    else result[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!result.listWorkflows && !result.validateWorkflows && !clean(result.prompt)) throw new AgentImageGenerationError("生成图片时必须填写 --prompt。 ");
  return result;
}

export function normalizeAgentImageConfig(value = {}) {
  const source = plainObject(value); const comfy = plainObject(source.comfyui); const selected = clean(source.default_backend ?? source.defaultBackend) || DEFAULT_CONFIG.defaultBackend;
  if (!["api", "comfyui"].includes(selected)) throw new AgentImageGenerationError(`未知图像生成后端：${selected}`);
  const timeoutSeconds = Number(comfy.timeout_seconds ?? comfy.timeoutSeconds ?? DEFAULT_CONFIG.comfyui.timeoutMs / 1000); const pollSeconds = Number(comfy.poll_interval_seconds ?? comfy.pollIntervalSeconds ?? DEFAULT_CONFIG.comfyui.pollIntervalMs / 1000);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new AgentImageGenerationError("comfyui.timeout_seconds 必须大于 0。 ");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 0.1 || pollSeconds > 30) throw new AgentImageGenerationError("comfyui.poll_interval_seconds 必须在 0.1 到 30 之间。 ");
  const output = plainObject(source.output); return { defaultBackend: selected, outputDirectory: clean(output.directory ?? source.outputDirectory) || DEFAULT_CONFIG.outputDirectory, comfyui: { baseUrl: clean(comfy.base_url ?? comfy.baseUrl) || DEFAULT_CONFIG.comfyui.baseUrl, timeoutMs: Math.round(timeoutSeconds * 1000), pollIntervalMs: Math.round(pollSeconds * 1000), registry: clean(comfy.registry) || DEFAULT_CONFIG.comfyui.registry, defaultWorkflow: clean(comfy.default_workflow ?? comfy.defaultWorkflow) } };
}

export async function loadAgentImageConfig({ agentRoot, configPath = "" } = {}) {
  const root = requiredRoot(agentRoot, "当前 Agent 数据目录"); const target = configPath ? safeChild(root, configPath, "--config") : path.join(root, "image-generation", "config.json");
  try { return { config: normalizeAgentImageConfig(await readJson(target, "图像生成配置")), path: target, source: "saved" }; }
  catch (error) { if (error instanceof AgentImageGenerationError && error.message === "找不到图像生成配置。") return { config: normalizeAgentImageConfig(), path: target, source: "default" }; throw error; }
}

async function loadComfyRegistry({ agentRoot, configPath, registryPath }) {
  const root = requiredRoot(agentRoot, "当前 Agent 数据目录"); const registryFile = safeChild(root, path.resolve(path.dirname(configPath), registryPath), "ComfyUI registry"); const registry = await readJson(registryFile, "ComfyUI registry");
  if (registry.version !== 1 || !plainObject(registry.workflows)) throw new AgentImageGenerationError("ComfyUI registry 必须包含 version: 1 和 workflows 对象。 ");
  const workflows = {};
  for (const [id, raw] of Object.entries(registry.workflows)) {
    const entry = plainObject(raw); const file = clean(entry.file); if (!file) throw new AgentImageGenerationError(`工作流 ${id}.file 不能为空。`);
    const workflowPath = safeChild(root, path.resolve(path.dirname(registryFile), file), `工作流 ${id}.file`); const workflow = await readJson(workflowPath, `工作流 ${id}`);
    if (Array.isArray(workflow.nodes)) throw new AgentImageGenerationError(`${path.basename(workflowPath)} 是 ComfyUI 界面工作流，不是 API Format。`);
    workflows[id] = { enabled: entry.enabled === true, description: clean(entry.description), workflow, bindings: plainObject(entry.bindings), defaults: plainObject(entry.defaults), reference_slots: Array.isArray(entry.reference_slots) ? entry.reference_slots : [], output_nodes: Array.isArray(entry.output_nodes) ? entry.output_nodes : [] };
  }
  const workbenchRegistry = { version: 1, workflows };
  try { return { registryFile, registry: workbenchRegistry, validatedRegistry: validateComfyRegistry(workbenchRegistry) }; } catch (error) { throw new AgentImageGenerationError(error.message); }
}

export async function listComfyWorkflows({ agentRoot, configPath = "" } = {}) {
  const root = requiredRoot(agentRoot, "当前 Agent 数据目录"); const loaded = await loadAgentImageConfig({ agentRoot: root, configPath }); const registryFile = safeChild(root, path.resolve(path.dirname(loaded.path), loaded.config.comfyui.registry), "ComfyUI registry"); const raw = await readJson(registryFile, "ComfyUI registry");
  if (raw.version !== 1 || !plainObject(raw.workflows)) throw new AgentImageGenerationError("ComfyUI registry 必须包含 version: 1 和 workflows 对象。 ");
  return { status: "ok", registry: path.relative(path.resolve(agentRoot), registryFile).split(path.sep).join("/"), workflows: Object.entries(raw.workflows).map(([id, entry]) => ({ id, enabled: entry?.enabled === true, description: clean(entry?.description), file: clean(entry?.file) })) };
}

export async function validateComfyWorkflows({ agentRoot, configPath = "" } = {}) {
  const loaded = await loadAgentImageConfig({ agentRoot, configPath }); const { registryFile, validatedRegistry } = await loadComfyRegistry({ agentRoot, configPath: loaded.path, registryPath: loaded.config.comfyui.registry });
  return { status: "valid", registry: path.relative(path.resolve(agentRoot), registryFile).split(path.sep).join("/"), workflows: Object.values(validatedRegistry.workflows).map(({ id, enabled }) => ({ id, enabled })) };
}

function usageEvent({ agentId, connection, item }) {
  const local = item.input.backend === "comfyui";
  return { agentId, provider: local ? "本地 ComfyUI" : (connection.provider || "OpenAI Compatible"), model: item.result.model, source: "图片生成", feature: local ? "image-workflow" : "image-" + item.result.mode, requestId: item.result.requestId, usage: item.result.usage, units: { imageRequests: 1, generatedImages: 1 }, metadata: { costSource: local ? "local-unpriced" : "provider-reported", size: item.input.size, referenceCount: item.referenceCount, backend: item.input.backend, workflow: item.result.workflow || "", agentInvocation: true } };
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
  const root = requiredRoot(agentRoot, "当前 Agent 数据目录"); const prompt = bounded(options.prompt, "--prompt", 4000); const loaded = await loadAgentImageConfig({ agentRoot: root, configPath: options.config }); const backend = clean(options.backend) || loaded.config.defaultBackend;
  if (!["api", "comfyui"].includes(backend)) throw new AgentImageGenerationError("--backend 必须是 api 或 comfyui。 ");
  const references = await loadReferences(options.refs || []); const outputRoot = safeChild(root, options.out || loaded.config.outputDirectory, "--out"); let connection; let registry = { version: 1, workflows: {} }; let workflow = clean(options.workflow);
  if (backend === "api") {
    connection = connectionResolver ? await connectionResolver({ dataRoot, environment }) : asDashScopeImageConnection(await createDashScopeConnectionService({ dataRoot, safeStorage: { isEncryptionAvailable: () => false }, environment }).resolve());
  } else {
    const loadedRegistry = await loadComfyRegistry({ agentRoot: root, configPath: loaded.path, registryPath: loaded.config.comfyui.registry }); registry = loadedRegistry.registry; connection = { baseUrl: loaded.config.comfyui.baseUrl, timeoutMs: loaded.config.comfyui.timeoutMs, pollIntervalMs: loaded.config.comfyui.pollIntervalMs }; workflow ||= loaded.config.comfyui.defaultWorkflow;
  }
  const ledgerPath = path.join(root, "cost-ledger", "events.jsonl"); const run = await createCandidates({ root: outputRoot, connection, registry, input: { prompt, backend, workflow, count: 1, size: clean(options.size) || "1024x1024", seed: Number.isInteger(options.seed) ? options.seed : null }, references, maxReferences: 16, fetchImpl, imageDownloader, onSuccess: async (item) => { if (backend === "api") await appendLedger(ledgerPath, usageEvent({ agentId, connection, item })); } });
  const candidate = run.candidates[0]; const outputPath = path.join(outputRoot, candidate.file);
  return { status: "ok", backend, path: outputPath, sent: false, model: candidate.model, requestId: candidate.requestId || "", seed: candidate.seed, workflow: candidate.workflow || "", references: references.map(({ id, role }) => ({ id, role })), configSource: loaded.source };
}

export async function runAgentImageGenerationCli(values, dependencies = {}) {
  const options = parseImageGenerationArgs(values); const environment = dependencies.environment || process.env; const dataRoot = resolveSuzuLivesDataRoot({ configuredRoot: options.dataRoot || environment.SUZU_LIVES_DATA_ROOT, localAppData: environment.LOCALAPPDATA, fallbackBase: "" }); const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: options.agentId || environment.SUZU_LIVES_AGENT_ID, projectRoot: options.projectRoot || environment.SUZU_LIVES_PROJECT_ROOT });
  if (options.listWorkflows) return listComfyWorkflows({ agentRoot, configPath: options.config }); if (options.validateWorkflows) return validateComfyWorkflows({ agentRoot, configPath: options.config });
  try { return await runAgentImageGeneration({ ...dependencies, agentRoot, agentId: options.agentId || environment.SUZU_LIVES_AGENT_ID, dataRoot, options, environment }); } catch (error) { if (error instanceof AgentImageGenerationError || error instanceof ImageWorkbenchError) throw new AgentImageGenerationError(error.message); throw error; }
}
