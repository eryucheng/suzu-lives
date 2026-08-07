import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentDataRoot,
  resolveSuzuLivesDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import {
  createClaudeCliGenerator,
} from "@suzu-lives/memory-compactor";
import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import { processPendingStateAnalysisRequests } from "./state-analysis-request-service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function parseOptions(values) {
  const options = {};
  const allowed = new Set([
    "project-root",
    "data-root",
    "database",
    "agent",
    "max-requests",
    "model",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) throw new Error(`memory-analyze 不支持位置参数：${value}`);
    const key = value.slice(2);
    if (!allowed.has(key)) throw new Error(`memory-analyze 不支持选项 --${key}。`);
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`memory-analyze 选项 --${key} 缺少值。`);
    }
    options[key] = String(next);
    index += 1;
  }
  return options;
}

function boundedMaximum(value) {
  if (value === undefined || value === "") return 10;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("memory-analyze 的 --max-requests 必须是 1 到 500 的整数。");
  }
  return parsed;
}

function dataRoot(value) {
  return resolveSuzuLivesDataRoot({
    configuredRoot: clean(value) || process.env.SUZU_LIVES_DATA_ROOT || "",
    localAppData: process.env.LOCALAPPDATA || "",
    fallbackBase: "",
  });
}

export function memoryStateAnalysisUsage() {
  return "suzu-lives memory-analyze [--project-root <Agent项目目录>] [--data-root <软件数据目录>] [--max-requests <1-500>]";
}

/** Explicit, bounded single-worker entry. It never starts a scheduler. */
export async function runMemoryStateAnalysisCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
  agentGeneratorFactory = createClaudeCliGenerator,
} = {}) {
  const options = parseOptions(args);
  const projectRoot = path.resolve(clean(options["project-root"]) || process.cwd());
  const softwareDataDirectory = dataRoot(options["data-root"]);
  const agentId = clean(options.agent) || stableAgentId(projectRoot);
  if (!agentId) throw new Error("memory-analyze 无法定位当前 Agent。 ");
  const agentRoot = resolveAgentDataRoot({ dataRoot: softwareDataDirectory, agentId });
  const databasePath = path.resolve(
    clean(options.database) || path.join(agentRoot, "memory", "memory.db"),
  );
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error("当前 Agent 的记忆数据库尚未建立。 ");
  }
  const maxRequests = boundedMaximum(options["max-requests"]);
  const usageLedgerPath = path.join(agentRoot, "cost-ledger", "events.jsonl");
  const generator = agentGeneratorFactory({ model: clean(options.model) });
  const database = openMemoryDatabase(databasePath);
  let result;
  try {
    result = await processPendingStateAnalysisRequests({
      repository: new MemoryRepository(database),
      agentId,
      generator,
      maxRequests,
      usageLedgerPath,
    });
  } finally {
    database.close();
  }
  const summary = {
    status: result.status,
    processorVersion: result.processorVersion,
    agentId,
    maxRequests,
    selected: result.selected,
    counts: result.counts,
    generatorMode: "current-agent",
    databasePath,
  };
  stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return { ...result, generatorMode: summary.generatorMode, databasePath };
}
