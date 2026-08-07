import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  MEMORY_COMPACTION_SCHEMA,
  parseGeneratedCompaction,
} from "./prompt.mjs";

function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/u, ""));
}

function inheritedClaudeEnvironment() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const settings = parseJson(fs.readFileSync(settingsPath, "utf8"));
    return settings.env && typeof settings.env === "object" ? settings.env : {};
  } catch (error) {
    throw new Error(`无法读取 ${settingsPath} 的 env：${error.message}`);
  }
}

function parseCliEnvelope(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("一次性摘要会话没有返回内容。");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new Error(`一次性摘要会话输出不是有效 JSON：${error.message}`);
  }
  if (envelope?.is_error || envelope?.type !== "result") {
    throw new Error(`一次性摘要会话失败：${text}`);
  }
  return envelope;
}

export function createClaudeCliGenerator({
  command = "claude",
  args = [],
  environment = {},
  model = "",
  structuredOutput = true,
  timeoutMs = 180_000,
} = {}) {
  return async function generate({
    input,
    systemPrompt,
    schema = MEMORY_COMPACTION_SCHEMA,
    schemaName = "memory-compaction-v1",
  }) {
    const started = Date.now();
    const cliArgs = [
      ...args.map(String),
      "-p",
      "--bare",
      "--tools",
      "",
      "--max-turns",
      structuredOutput ? "2" : "1",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--system-prompt",
      systemPrompt,
    ];
    if (model) cliArgs.push("--model", model);
    if (structuredOutput) {
      cliArgs.push("--json-schema", JSON.stringify(schema));
    }
    const result = spawnSync(command, cliArgs, {
      input,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        ...inheritedClaudeEnvironment(),
        ...environment,
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw new Error(`无法启动一次性摘要会话：${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`一次性摘要会话失败（${result.status}）：${result.stderr || result.stdout}`);
    }
    const envelope = parseCliEnvelope(result.stdout);
    const structuredResult = envelope.structured_output ?? envelope.result;
    return {
      output: schemaName === "memory-compaction-v1"
        ? parseGeneratedCompaction(structuredResult)
        : structuredResult,
      usage: envelope.usage || {},
      model: model || envelope.modelUsage && Object.keys(envelope.modelUsage)[0] || "",
      requestId: envelope.request_id || envelope.uuid || "",
      durationMs: Date.now() - started,
      metadata: {
        sessionId: envelope.session_id || "",
        totalCostUsd: envelope.total_cost_usd ?? null,
        structuredOutput,
      },
    };
  };
}
