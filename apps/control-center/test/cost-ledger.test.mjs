import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import { scanCostLedger } from "../electron/services/cost-ledger.mjs";

async function temporaryRoot(label) {
  return fs.mkdtemp(path.join(process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp", `suzu-agent-core-ledger-${label}-`));
}

function contactScope({
  contactId = "contact-suzu",
  contactName = "Suzu",
  projectRoot,
  sessionId = "session",
  usageLedgerPath = "",
} = {}) {
  return { contactId, contactName, projectRoot, sessionId, usageLedgerPath };
}

test("an empty Agent Core ledger does not invent external usage", async () => {
  const root = await temporaryRoot("external-history");
  const projectRoot = path.join(root, "contact-project");
  await fs.mkdir(projectRoot, { recursive: true });

  const result = await scanCostLedger({}, {
    contactScopes: [contactScope({ projectRoot })],
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.summary.all.requestCount, 0);
  assert.equal(result.diagnostics.transcript.status, "ready");
  assert.equal(result.sources.find((source) => source.id === "agent-core-session-meter")?.tracked, true);
  assert.equal(result.warning, "");
});

test("Agent Core ledger includes product-owned unified usage events and applies price revisions", async () => {
  const root = await temporaryRoot("unified");
  const projectRoot = path.join(root, "contact-project");
  const ledgerPath = path.join(root, "software-data", "events.jsonl");
  await fs.mkdir(projectRoot, { recursive: true });
  await appendUsageEvent(ledgerPath, {
    timestamp: "2026-07-30T02:00:00.000Z",
    model: "text-embedding-v4",
    source: "RAG 向量",
    feature: "rag-embedding",
    requestId: "embedding-1",
    usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
  });

  const result = await scanCostLedger({}, {
    contactScopes: [contactScope({ projectRoot, usageLedgerPath: ledgerPath })],
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].source, "RAG 向量");
  assert.equal(result.events[0].contactName, "Suzu");
  assert.ok(Math.abs(result.summary.all.amountCny - 0.5) < 0.000001);
});

test("Agent Core ledger includes live public chat and compaction usage from the unified ledger", async () => {
  const root = await temporaryRoot("live-agent-core");
  const projectRoot = path.join(root, "contact-project");
  const ledgerPath = path.join(root, "software-data", "events.jsonl");
  await fs.mkdir(projectRoot, { recursive: true });
  await Promise.all([
    appendUsageEvent(ledgerPath, {
      id: "agent-core:session-1:4",
      timestamp: "2026-08-17T01:00:00.000Z",
      agentId: "agent-suzu",
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      source: "Agent 对话",
      feature: "agent-chat",
      requestId: "agent-core:session-1:4",
      usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 },
      units: { inputUncachedTokens: 100, inputCachedTokens: 20, outputTextTokens: 30 },
      metadata: { runtime: "agent-core", sessionId: "session-1", coreSequence: 4 },
    }),
    appendUsageEvent(ledgerPath, {
      id: "agent-core:session-1:9",
      timestamp: "2026-08-17T01:01:00.000Z",
      agentId: "agent-suzu",
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      source: "Agent 对话压缩",
      feature: "agent-compaction",
      requestId: "agent-core:session-1:9",
      usage: { inputTokens: 80, outputTokens: 10 },
      units: { inputUncachedTokens: 80, outputTextTokens: 10 },
      metadata: { runtime: "agent-core", sessionId: "session-1", coreSequence: 9 },
    }),
  ]);

  const result = await scanCostLedger({}, {
    contactScopes: [contactScope({ projectRoot, usageLedgerPath: ledgerPath })],
  });
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.feature).sort(), ["agent-chat", "agent-compaction"]);
  assert.equal(result.diagnostics.transcript.scannedRecords, 2);
  const agentCoreSource = result.sources.find((source) => source.id === "agent-core-session-meter");
  assert.equal(agentCoreSource?.tracked, true);
  assert.match(agentCoreSource?.detail || "", /已记录 2 次调用/u);
  assert.ok(result.summary.all.amountCny > 0);
});

test("Agent Core ledger keeps unified events scoped to their contact", async () => {
  const root = await temporaryRoot("contacts");
  const suzuRoot = path.join(root, "suzu-project");
  const workRoot = path.join(root, "work-project");
  const suzuLedger = path.join(root, "data", "suzu.jsonl");
  const workLedger = path.join(root, "data", "work.jsonl");
  await fs.mkdir(suzuRoot, { recursive: true });
  await fs.mkdir(workRoot, { recursive: true });
  await Promise.all([
    appendUsageEvent(suzuLedger, { timestamp: "2026-08-01T00:00:00.000Z", model: "text-embedding-v4", source: "向量", feature: "embedding", requestId: "same-request", usage: { prompt_tokens: 1 } }),
    appendUsageEvent(workLedger, { timestamp: "2026-08-01T00:00:00.000Z", model: "text-embedding-v4", source: "向量", feature: "embedding", requestId: "same-request", usage: { prompt_tokens: 1 } }),
  ]);

  const result = await scanCostLedger({}, {
    contactScopes: [
      contactScope({ contactId: "contact-suzu", contactName: "Suzu", projectRoot: suzuRoot, usageLedgerPath: suzuLedger }),
      contactScope({ contactId: "contact-work", contactName: "工作", projectRoot: workRoot, usageLedgerPath: workLedger }),
    ],
  });
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.contactName).sort(), ["Suzu", "工作"]);
  assert.equal(result.summary.all.requestCount, 2);
});
