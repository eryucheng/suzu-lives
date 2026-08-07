import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  scanCostLedger,
} from "../electron/services/cost-ledger.mjs";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { encodeClaudeProjectDirectory } from "@suzu-lives/agent-registry";

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function writeClaudeSession({ projectRoot, homeDirectory, records, name = "session.jsonl" }) {
  fs.mkdirSync(projectRoot, { recursive: true });
  const transcript = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectDirectory(projectRoot), name);
  writeJsonl(transcript, records);
  return transcript;
}

test("scans DeepSeek transcript usage and groups one conversation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-console-test-"));
  const projectRoot = path.join(root, "contact-project");
  const homeDirectory = path.join(root, "home");
  writeClaudeSession({ projectRoot, homeDirectory, records: [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-29T01:00:00.000Z",
      message: { role: "user", content: "帮我看看今天花了多少钱" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-07-29T01:00:02.000Z",
      message: {
        role: "assistant",
        id: "msg-1",
        model: "deepseek-v4-pro",
        content: [{ type: "text", text: "好的" }],
        usage: {
          input_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        },
      },
    },
  ] });

  const result = await scanCostLedger({
    projectRoot,
  }, { homeDirectory });
  assert.equal(result.status, "ready");
  assert.equal(result.events.length, 1);
  assert.equal(result.summary.all.requestCount, 1);
  assert.equal(result.summary.conversations.length, 1);
  assert.equal(result.summary.conversations[0].prompt, "帮我看看今天花了多少钱");
  assert.ok(Math.abs(result.summary.all.amountCny - 9.025) < 0.000001);
});

test("applies a software price revision from its effective time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-console-price-"));
  const projectRoot = path.join(root, "contact-project");
  const homeDirectory = path.join(root, "home");
  writeClaudeSession({ projectRoot, homeDirectory, records: [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "user", content: "价格设置测试" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-01T00:00:02.000Z",
      message: {
        role: "assistant",
        id: "msg-1",
        model: "deepseek-v4-pro",
        content: [{ type: "text", text: "好的" }],
        usage: {
          input_tokens: 1_000_000,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  ] });
  const result = await scanCostLedger({
    projectRoot,
    usageLedgerPath: path.join(root, "runtime", "events.jsonl"),
    priceRevisions: [
      {
        modelId: "deepseek-v4-pro",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        rates: {
          inputUncachedTokens: 5,
          inputCachedTokens: 0.025,
          outputTextTokens: 6,
        },
      },
    ],
  }, { homeDirectory });
  assert.equal(result.events.length, 1);
  assert.ok(Math.abs(result.summary.all.amountCny - 5) < 0.000001);
});

test("includes events written through the unified ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-console-unified-"));
  const projectRoot = path.join(root, "contact-project");
  const homeDirectory = path.join(root, "home");
  const ledgerPath = path.join(root, "software-data", "events.jsonl");
  writeClaudeSession({ projectRoot, homeDirectory, records: [] });
  await appendUsageEvent(ledgerPath, {
    timestamp: "2026-07-30T02:00:00.000Z",
    model: "text-embedding-v4",
    source: "RAG 向量",
    feature: "rag-embedding",
    requestId: "embedding-1",
    usage: {
      prompt_tokens: 1_000_000,
      total_tokens: 1_000_000,
    },
  });
  const result = await scanCostLedger({
    projectRoot,
    usageLedgerPath: ledgerPath,
  }, { homeDirectory });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].source, "RAG 向量");
  assert.ok(Math.abs(result.summary.all.amountCny - 0.5) < 0.000001);
});
