import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveAgentDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { planMemoryConsolidation } from "@suzu-lives/memory-structurer";

import { runMemoryConsolidationCli } from "../src/memory-consolidation-cli.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-consolidation-cli-"));
  const projectRoot = path.join(root, "agent-project");
  const dataRoot = path.join(root, "software-data");
  fs.mkdirSync(projectRoot, { recursive: true });
  const agentId = stableAgentId(projectRoot);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  const databasePath = path.join(agentRoot, "memory", "memory.db");
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  for (const id of ["new-memory", "old-memory"]) {
    repository.upsertMemory({
      id,
      agentId,
      kind: "event",
      layer: "episodic",
      content: `${id} 的测试内容，不应出现在命令摘要中。`,
      eventStart: id === "new-memory"
        ? "2026-08-03T08:00:00.000Z"
        : "2026-07-03T08:00:00.000Z",
    });
  }
  repository.upsertEdge({
    agentId,
    fromMemoryId: "new-memory",
    toMemoryId: "old-memory",
    relation: "associated_with",
    direction: "undirected",
    weight: 1,
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId,
    triggerMemoryIds: ["new-memory"],
  });
  database.close();
  return { root, projectRoot, dataRoot, agentId, databasePath, plan };
}

test("memory-consolidate processes an explicit bounded batch without exposing content", async () => {
  const value = fixture();
  let output = "";
  let generatorCalls = 0;
  const result = await runMemoryConsolidationCli({
    args: [
      "--project-root", value.projectRoot,
      "--data-root", value.dataRoot,
      "--max-runs", "1",
    ],
    stdout: { write(text) { output += text; } },
    agentGeneratorFactory: () => async () => {
      generatorCalls += 1;
      return { output: { proposals: [] } };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.selected, 1);
  assert.equal(result.generatorMode, "current-agent");
  assert.equal(generatorCalls, 1);
  const summary = JSON.parse(output);
  assert.equal(summary.results[0].runId, value.plan.id);
  assert.equal(summary.results[0].status, "no-proposals");
  assert.doesNotMatch(output, /测试内容/u);
});

test("memory-consolidate requires a cost bound and skips model setup when no plan exists", async () => {
  const value = fixture();
  await assert.rejects(runMemoryConsolidationCli({
    args: ["--project-root", value.projectRoot, "--data-root", value.dataRoot],
  }), /必须显式提供 --max-runs/u);

  const database = openMemoryDatabase(value.databasePath);
  const repository = new MemoryRepository(database);
  repository.claimConsolidationRun({ agentId: value.agentId, runId: value.plan.id });
  repository.finishConsolidationRun({
    agentId: value.agentId,
    runId: value.plan.id,
    status: "no_proposals",
  });
  database.close();

  let factoryCalls = 0;
  let output = "";
  const result = await runMemoryConsolidationCli({
    args: [
      "--project-root", value.projectRoot,
      "--data-root", value.dataRoot,
      "--max-runs", "1",
    ],
    stdout: { write(text) { output += text; } },
    agentGeneratorFactory: () => {
      factoryCalls += 1;
      return async () => ({ output: { proposals: [] } });
    },
  });
  assert.equal(result.selected, 0);
  assert.equal(result.generatorMode, "not-needed");
  assert.equal(factoryCalls, 0);
  assert.equal(JSON.parse(output).selected, 0);
});

test("memory-consolidate always uses the current Agent model", async () => {
  const value = fixture();
  let agentFactoryCalls = 0;
  const result = await runMemoryConsolidationCli({
    args: [
      "--project-root", value.projectRoot,
      "--data-root", value.dataRoot,
      "--max-runs", "1",
    ],
    stdout: { write() {} },
    connectionResolver: async () => ({
      id: "memory-api",
      source: "saved",
      baseUrl: "https://example.invalid/v1",
      model: "memory-model",
      key: "secret",
    }),
    agentGeneratorFactory: () => {
      agentFactoryCalls += 1;
      return async () => ({ output: { proposals: [] } });
    },
  });
  assert.equal(result.generatorMode, "current-agent");
  assert.equal(agentFactoryCalls, 1);
});
