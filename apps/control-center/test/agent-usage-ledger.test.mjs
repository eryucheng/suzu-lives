import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { appendUsageEvent, readUsageEvents } from "@suzu-lives/cost-ledger";
import { createAgentUsageLedger } from "../electron/services/agent-usage-ledger.mjs";
import { createConversationReader } from "../electron/services/conversation-reader.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-agent-usage-ledger-"));
}

function historyWithUsage() {
  return {
    events: [
      { event: {
        type: "assistant/message",
        seq: 4,
        time: Date.parse("2026-08-21T12:00:00.000Z"),
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { provider: "DeepSeek", model: "deepseek-v4-flash" },
            content: [{ type: "text", text: "第一条回复" }],
          },
          usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 },
        },
      } },
      { event: {
        type: "compaction/summary",
        seq: 9,
        time: Date.parse("2026-08-21T12:01:00.000Z"),
        data: {
          turn: 1,
          compactionId: "compact-1",
          provider: "DeepSeek",
          model: "deepseek-v4-flash",
          usage: { inputTokens: 80, outputTokens: 10 },
        },
      } },
    ],
    hasMore: false,
  };
}

test("Agent Core history backfills a missed usage ledger record exactly once", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  const ledgerPath = path.join(root, "agents", "agent-suzu", "cost-ledger", "events.jsonl");
  await fs.mkdir(projectRoot, { recursive: true });
  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    agentId: "agent-suzu",
    projectRoot,
    sessionId: "contact-session",
  };
  const history = historyWithUsage();
  const runtime = {
    async history() { return history; },
  };
  const capabilityCalls = [];
  const capabilityRuntime = {
    async recordUsage({ ledgerPath: destination, event }) {
      capabilityCalls.push(event);
      await appendUsageEvent(destination, event);
      return [{ status: "completed" }];
    },
  };
  const settingsService = {
    load: () => ({ dataRoot: root }),
    usageLedgerPath: () => ledgerPath,
  };

  let usageLedger = null;
  const reader = createConversationReader({
    runtime,
    settingsService,
    contactProjectsService: {
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: root,
          contacts: [contact],
          activeContact: contact,
          preferredContact: contact,
        };
      },
    },
    onAgentUsageEvents: (value) => usageLedger?.reconcile(value) || { completed: false },
  });
  usageLedger = createAgentUsageLedger({ capabilityRuntime, reader, settingsService });

  await reader.snapshot();
  await reader.snapshot();
  assert.equal(capabilityCalls.length, 2);
  assert.deepEqual(capabilityCalls.map((event) => event.id), [
    "agent-core:contact-session:4",
    "agent-core:contact-session:9",
  ]);
  assert.deepEqual(capabilityCalls[0].units, {
    inputUncachedTokens: 100,
    inputCachedTokens: 20,
    outputTextTokens: 30,
  });

  const stored = await readUsageEvents(ledgerPath);
  assert.equal(stored.events.length, 2);

  // The cache is only a performance optimization. A fresh Electron process
  // reads the ledger and still refuses to append the same immutable Core ids.
  const afterRestart = createAgentUsageLedger({ capabilityRuntime, reader, settingsService });
  const recovered = await afterRestart.reconcile({
    contact: {
      contactId: contact.id,
      agentId: contact.agentId,
      projectRoot,
      sessionId: contact.sessionId,
    },
    events: history.events,
  });
  assert.equal(recovered.duplicates, 2);
  assert.equal(capabilityCalls.length, 2);
  assert.equal((await readUsageEvents(ledgerPath)).events.length, 2);
});
