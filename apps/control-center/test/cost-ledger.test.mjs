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

function contactScope({
  contactId = "contact-suzu",
  contactName = "Suzu",
  projectRoot,
  usageLedgerPath = "",
} = {}) {
  return {
    contactId,
    contactName,
    projectRoot,
    sessionId: "session",
    usageLedgerPath,
  };
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

  const result = await scanCostLedger({}, {
    contactScopes: [contactScope({ projectRoot })],
    homeDirectory,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.events.length, 1);
  assert.equal(result.summary.all.requestCount, 1);
  assert.equal(result.summary.conversations.length, 1);
  assert.equal(result.summary.conversations[0].prompt, "帮我看看今天花了多少钱");
  assert.equal(result.events[0].contactName, "Suzu");
  assert.equal(result.summary.conversations[0].contactName, "Suzu");
  assert.ok(Math.abs(result.summary.all.amountCny - 9.025) < 0.000001);
});

test("ignores Claude synthetic no-response records in transcript cost rows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-console-synthetic-"));
  const projectRoot = path.join(root, "contact-project");
  const homeDirectory = path.join(root, "home");
  writeClaudeSession({ projectRoot, homeDirectory, records: [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-08-15T12:00:00.000Z",
      message: { role: "user", content: "这条真实回复要保留" },
    },
    {
      type: "assistant",
      uuid: "synthetic-no-response",
      parentUuid: "resume-meta",
      timestamp: "2026-08-15T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested." }],
        usage: {},
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-15T12:00:02.000Z",
      message: {
        role: "assistant",
        id: "msg-1",
        model: "deepseek-v4-pro",
        content: [{ type: "text", text: "真实回复" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ] });

  const result = await scanCostLedger({}, {
    contactScopes: [contactScope({ projectRoot })],
    homeDirectory,
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].model, "deepseek-v4-pro");
  assert.equal(result.summary.all.requestCount, 1);
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
  }, {
    contactScopes: [contactScope({
      projectRoot,
      usageLedgerPath: path.join(root, "runtime", "events.jsonl"),
    })],
    homeDirectory,
  });
  assert.equal(result.events.length, 1);
  assert.ok(Math.abs(result.summary.all.amountCny - 5) < 0.000001);
});

test("scans a user-created model mapping from a contact transcript", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-console-custom-price-"));
  const projectRoot = path.join(root, "contact-project");
  const homeDirectory = path.join(root, "home");
  writeClaudeSession({ projectRoot, homeDirectory, records: [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-08-17T00:00:00.000Z",
      message: { role: "user", content: "自定义模型价格" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-17T00:00:02.000Z",
      message: {
        role: "assistant",
        id: "msg-custom-1",
        model: "openai/gpt-4.1-mini",
        content: [{ type: "text", text: "已识别。" }],
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
    },
  ] });

  const result = await scanCostLedger({
    customPriceModels: [{
      modelId: "openai/gpt-4.1-mini",
      label: "GPT-4.1 mini",
      provider: "OpenAI",
      effectiveFrom: "2026-08-17T00:00:00.000Z",
      rateDefinitions: {
        inputTokens: { label: "输入", unitLabel: "元 / 百万 Token", per: 1_000_000 },
        outputTextTokens: { label: "输出", unitLabel: "元 / 百万 Token", per: 1_000_000 },
      },
      rates: { inputTokens: 2, outputTextTokens: 8 },
    }],
  }, {
    contactScopes: [contactScope({ projectRoot })],
    homeDirectory,
  });

  assert.equal(result.events[0].provider, "OpenAI");
  assert.ok(Math.abs(result.events[0].amountCny - 10) < 0.000001);
  assert.equal(result.priceCatalog.models.find((item) => item.modelId === "openai/gpt-4.1-mini")?.isUserDefined, true);
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
  const result = await scanCostLedger({}, {
    contactScopes: [contactScope({ projectRoot, usageLedgerPath: ledgerPath })],
    homeDirectory,
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].source, "RAG 向量");
  assert.equal(result.events[0].contactName, "Suzu");
  assert.ok(Math.abs(result.summary.all.amountCny - 0.5) < 0.000001);
});

test("aggregates every fixed contact session without mixing their conversation rows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-console-all-contacts-"));
  const homeDirectory = path.join(root, "home");
  const suzuProjectRoot = path.join(root, "suzu-project");
  const workProjectRoot = path.join(root, "work-project");
  const records = (reply) => [
    {
      type: "user",
      uuid: "turn-shared",
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "user", content: "同一个轮次标识也要分联系人统计" },
    },
    {
      type: "assistant",
      uuid: "reply-shared",
      timestamp: "2026-08-01T00:00:02.000Z",
      message: {
        role: "assistant",
        id: "request-shared",
        model: "deepseek-v4-pro",
        content: [{ type: "text", text: reply }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  writeClaudeSession({ projectRoot: suzuProjectRoot, homeDirectory, records: records("Suzu 的回复") });
  writeClaudeSession({ projectRoot: workProjectRoot, homeDirectory, records: records("工作会话的回复") });

  const result = await scanCostLedger({}, {
    contactScopes: [
      contactScope({ contactId: "contact-suzu", contactName: "Suzu", projectRoot: suzuProjectRoot }),
      contactScope({ contactId: "contact-work", contactName: "工作", projectRoot: workProjectRoot }),
    ],
    homeDirectory,
  });

  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.contactName).sort(), ["Suzu", "工作"]);
  assert.equal(result.summary.all.requestCount, 2);
  assert.equal(result.summary.conversations.length, 2);
  assert.deepEqual(result.summary.conversations.map((item) => item.contactName).sort(), ["Suzu", "工作"]);
});
