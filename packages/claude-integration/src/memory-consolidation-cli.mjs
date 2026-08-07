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
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { processPlannedConsolidationRuns } from "@suzu-lives/memory-structurer";

function clean(value) {
  return String(value ?? "").trim();
}

function parseOptions(values) {
  const options = {};
  const allowed = new Set([
    "project-root", "data-root", "database", "agent", "max-runs", "model",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) throw new Error(`memory-consolidate 不支持位置参数：${value}`);
    const key = value.slice(2);
    if (!allowed.has(key)) throw new Error(`memory-consolidate 不支持选项 --${key}。`);
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`memory-consolidate 选项 --${key} 缺少值。`);
    }
    options[key] = String(next);
    index += 1;
  }
  return options;
}

function maximumRuns(value) {
  if (value === undefined || value === "") {
    throw new Error("memory-consolidate 必须显式提供 --max-runs，避免产生无界模型费用。");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("memory-consolidate 的 --max-runs 必须是 1 到 100 的整数。");
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

export function memoryConsolidationUsage() {
  return "suzu-lives memory-consolidate --max-runs <1-100> [--project-root <Agent项目目录>] [--data-root <软件数据目录>]";
}

/** Explicit bounded worker entry. It neither schedules itself nor accepts proposals. */
export async function runMemoryConsolidationCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
  agentGeneratorFactory = createClaudeCliGenerator,
} = {}) {
  const options = parseOptions(args);
  const runLimit = maximumRuns(options["max-runs"]);
  const projectRoot = path.resolve(clean(options["project-root"]) || process.cwd());
  const softwareDataDirectory = dataRoot(options["data-root"]);
  const agentId = clean(options.agent) || stableAgentId(projectRoot);
  if (!agentId) throw new Error("memory-consolidate 无法定位当前 Agent。 ");
  const agentRoot = resolveAgentDataRoot({ dataRoot: softwareDataDirectory, agentId });
  const databasePath = path.resolve(
    clean(options.database) || path.join(agentRoot, "memory", "memory.db"),
  );
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error("当前 Agent 的记忆数据库尚未建立。 ");
  }
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  try {
    const pending = repository.listConsolidationRuns(agentId, {
      statuses: ["planned"],
      limit: runLimit,
      order: "asc",
    });
    if (!pending.length) {
      const summary = {
        status: "completed",
        agentId,
        maxRuns: runLimit,
        selected: 0,
        counts: {},
        results: [],
        generatorMode: "not-needed",
        databasePath,
      };
      stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return summary;
    }
    const generator = agentGeneratorFactory({ model: clean(options.model) });
    const result = await processPlannedConsolidationRuns({
      repository,
      agentId,
      generator,
      maximumRuns: runLimit,
      usageLedgerPath: path.join(agentRoot, "cost-ledger", "events.jsonl"),
    });
    const summary = {
      status: result.status,
      agentId,
      maxRuns: runLimit,
      selected: result.selected,
      counts: result.counts,
      results: result.results.map((item) => ({
        runId: item.runId,
        status: item.status,
        structureProposalCount: item.structureProposalCount,
        relationProposalCount: item.relationProposalCount,
        hasError: Boolean(item.error),
      })),
      generatorMode: "current-agent",
      databasePath,
    };
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return { ...result, generatorMode: summary.generatorMode, databasePath };
  } finally {
    database.close();
  }
}
