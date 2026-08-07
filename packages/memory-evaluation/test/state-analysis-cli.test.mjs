import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveAgentDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import { openMemoryDatabase } from "@suzu-lives/memory-core";

import { runMemoryStateAnalysisCli } from "../src/state-analysis-cli.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-analyze-cli-"));
  const projectRoot = path.join(root, "agent");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(projectRoot, { recursive: true });
  const agentId = stableAgentId(projectRoot);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  const databasePath = path.join(agentRoot, "memory", "memory.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  openMemoryDatabase(databasePath).close();
  return { root, projectRoot, dataRoot, agentId, databasePath };
}

test("memory-analyze always uses the current Agent generator", async (context) => {
  const values = fixture();
  context.after(() => fs.rmSync(values.root, { recursive: true, force: true }));
  let agentFactoryCalls = 0;
  let output = "";
  const result = await runMemoryStateAnalysisCli({
    args: ["--project-root", values.projectRoot, "--data-root", values.dataRoot, "--max-requests", "3"],
    stdout: { write: (value) => { output += value; } },
    agentGeneratorFactory: () => {
      agentFactoryCalls += 1;
      return async () => ({ output: {} });
    },
  });
  assert.equal(agentFactoryCalls, 1);
  assert.equal(result.status, "empty");
  assert.equal(result.generatorMode, "current-agent");
  assert.match(output, /"selected": 0/u);
  assert.doesNotMatch(output, /results/u);
});

test("memory-analyze ignores unrelated software API bindings", async (context) => {
  const values = fixture();
  context.after(() => fs.rmSync(values.root, { recursive: true, force: true }));
  let agentFactoryCalls = 0;
  const result = await runMemoryStateAnalysisCli({
    args: ["--project-root", values.projectRoot, "--data-root", values.dataRoot],
    stdout: { write: () => undefined },
    connectionResolver: async () => ({
      id: "deepseek",
      name: "DeepSeek",
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "deepseek-chat",
      key: "secret",
      source: "saved",
    }),
    agentGeneratorFactory: () => {
      agentFactoryCalls += 1;
      return async () => ({ output: {} });
    },
  });
  assert.equal(agentFactoryCalls, 1);
  assert.equal(result.generatorMode, "current-agent");
});

test("memory-analyze rejects missing databases and unbounded request counts", async (context) => {
  const values = fixture();
  context.after(() => fs.rmSync(values.root, { recursive: true, force: true }));
  await assert.rejects(
    () => runMemoryStateAnalysisCli({
      args: ["--project-root", values.projectRoot, "--data-root", values.dataRoot, "--max-requests", "501"],
      stdout: { write: () => undefined },
    }),
    /1 到 500/u,
  );
  fs.unlinkSync(values.databasePath);
  await assert.rejects(
    () => runMemoryStateAnalysisCli({
      args: ["--project-root", values.projectRoot, "--data-root", values.dataRoot],
      stdout: { write: () => undefined },
    }),
    /尚未建立/u,
  );
});
