import fs from "node:fs";
import path from "node:path";

import {
  resolveSuzuLivesDataRoot,
  resolveTranscriptPath,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import { createOpenAiCompatibleEmbeddingProvider } from "@suzu-lives/memory-retriever";

import { createClaudeCliGenerator } from "./claude-cli.mjs";
import { runCompaction } from "./service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function parseOptions(values) {
  const options = {};
  const booleans = new Set(["dry-run"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) throw new Error(`memory-compact 不支持位置参数：${value}`);
    const key = value.slice(2);
    if (!key) throw new Error("memory-compact 参数无效。 ");
    if (booleans.has(key)) {
      options[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) throw new Error(`memory-compact 选项 --${key} 缺少值。`);
    options[key] = String(next);
    index += 1;
  }
  const allowed = new Set([
    "dry-run", "project-root", "data-root", "transcript", "now",
    "memory-owner", "user-name", "model",
  ]);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`memory-compact 不支持选项 --${unknown}。`);
  return options;
}

function dataRoot(value) {
  return resolveSuzuLivesDataRoot({
    configuredRoot: clean(value) || process.env.SUZU_LIVES_DATA_ROOT || "",
    localAppData: process.env.LOCALAPPDATA || "",
    fallbackBase: "",
  });
}

export function memoryCompactorUsage() {
  return "suzu-lives memory-compact [--dry-run] [--project-root <Agent项目目录>] [--transcript <Claude会话JSONL>] [--data-root <软件数据目录>]";
}

function selectedConnection(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    clean(value.id)
    || clean(value.name)
    || clean(value.baseUrl)
    || clean(value.model)
    || clean(value.apiKey || value.key)
    || !["", "none"].includes(clean(value.source).toLowerCase()),
  );
}

/**
 * Stable software entry for Suzu scheduled memory compaction. It never reads
 * manual_compactor configuration: an explicit --transcript wins, otherwise
 * the current Claude project-session directory is discovered.
 */
export async function runMemoryCompactorCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
  homeDirectory,
  connectionResolver = null,
  agentGeneratorFactory = createClaudeCliGenerator,
  embeddingProviderFactory = createOpenAiCompatibleEmbeddingProvider,
} = {}) {
  const options = parseOptions(args);
  const projectRoot = path.resolve(clean(options["project-root"]) || process.cwd());
  const agentId = stableAgentId(projectRoot);
  if (!agentId) throw new Error("memory-compact 无法定位当前 Agent 项目。 ");
  const softwareDataDirectory = dataRoot(options["data-root"]);
  const explicitTranscript = clean(options.transcript);
  const transcript = explicitTranscript
    ? { path: assertReadableTranscript(explicitTranscript), source: "explicit" }
    : await resolveTranscriptPath(projectRoot, { homeDirectory });
  if (!transcript.path) {
    throw new Error("当前 Agent 没有可用 Claude 会话 JSONL；请在软件中选择会话或传入 --transcript。 ");
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("--now 必须是有效时间。 ");
  const dryRun = options["dry-run"] === true;
  const generator = dryRun
    ? null
    : agentGeneratorFactory({ model: clean(options.model) });
  let embeddingProvider = null;
  if (!dryRun) {
    const embeddingConnection = typeof connectionResolver === "function"
      ? await connectionResolver({
        kind: "memory-embedding",
        dataRoot: softwareDataDirectory,
        agentId,
      })
      : null;
    if (selectedConnection(embeddingConnection)) {
      const type = clean(embeddingConnection.type);
      let baseUrl = clean(embeddingConnection.baseUrl).replace(/\/+$/u, "");
      if (type === "dashscope") {
        baseUrl = baseUrl.replace(/\/api\/v1$/u, "/compatible-mode/v1");
      }
      embeddingProvider = embeddingProviderFactory({
        baseUrl,
        apiKey: embeddingConnection.key || embeddingConnection.apiKey,
        model: clean(embeddingConnection.model) || (type === "dashscope" ? "text-embedding-v4" : ""),
        dimensions: 1024,
        extraBody: { encoding_format: "float" },
      });
    }
  }
  const result = await runCompaction({
    transcriptPath: transcript.path,
    agentId,
    softwareDataDirectory,
    memoryOwner: clean(options["memory-owner"]) || "Suzu",
    userName: clean(options["user-name"]) || "用户",
    generator,
    structureGenerator: generator,
    embeddingProvider,
    dryRun,
    now,
  });
  stdout.write(`${JSON.stringify({ ...result, transcriptSource: transcript.source }, null, 2)}\n`);
  return result;
}

export function assertReadableTranscript(filePath) {
  const target = path.resolve(clean(filePath));
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error("当前 Agent 没有可读的 Claude 会话 JSONL。 ");
  }
  return target;
}
