import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SUZU_COMPACTION_PROMPT } from "@suzu-lives/suzu-agent-runtime/companion-compaction-prompt";
import {
  createConversationCompactorService,
} from "../electron/services/conversation-compactor-service.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-agent-compactor-"));
}

function fixture(root, { hasHistory = true } = {}) {
  const projectRoot = path.join(root, "contact-suzu");
  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    projectRoot,
    sessionId: "session-suzu",
  };
  const events = hasHistory ? [
    { event: { type: "user/message", seq: 1, time: 1_000, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "今天想一起玩游戏" }] } } },
    { event: { type: "assistant/message", seq: 2, time: 2_000, surfaceOp: "append", data: { message: { content: [{ type: "text", text: "好呀，我们一起挑一个吧。" }] } } } },
  ] : [];
  const calls = { history: [], runCompaction: [] };
  const reader = {
    async compactorSnapshot() {
      return {
        status: "ready",
        activeContact: contact,
        contacts: [{ ...contact, sessions: [{ id: contact.sessionId }] }],
      };
    },
    async resolveCompactorSession({ contactId }) {
      assert.equal(contactId, contact.id);
      return { contactId: contact.id, id: contact.sessionId, projectRoot };
    },
    async resolveCompactorSessionForRuntime({ sessionId }) {
      assert.equal(sessionId, contact.sessionId);
      return { contactId: contact.id, id: contact.sessionId, projectRoot };
    },
  };
  const runtime = {
    async history(value) {
      calls.history.push(value);
      return { events, hasMore: false };
    },
    async runCompaction(value) {
      calls.runCompaction.push(value);
      events.push(
        { event: { type: "compaction/start", seq: 3, time: 3_000, data: { compactionId: "compact-1", turn: null } } },
        { event: { type: "compaction/summary", seq: 4, time: 4_000, data: {
          compactionId: "compact-1",
          summary: [{ type: "text", text: "我答应和用户一起挑游戏，用户今天想一起玩。" }],
          shadowedSeqs: [1],
          shadowedTokenCount: 120,
        } } },
        { event: { type: "user/message", seq: 5, time: 4_001, surfaceOp: { op: "replace", start: 1, end: 1 }, data: { source: { kind: "plugin" }, content: [{ type: "text", text: "model-only checkpoint" }] } } },
        { event: { type: "compaction/end", seq: 6, time: 5_000, data: { compactionId: "compact-1", turn: null } } },
      );
      return { accepted: true, completed: true, compactionId: "compact-1" };
    },
  };
  return { calls, contact, events, projectRoot, reader, runtime };
}

test("Agent compactor keeps editable per-contact rewind settings and uses only native Agent calls", async () => {
  const root = await temporaryRoot();
  const fake = fixture(root);
  await fs.mkdir(fake.projectRoot, { recursive: true });
  const service = createConversationCompactorService({
    reader: fake.reader,
    runtime: fake.runtime,
    now: () => new Date("2026-08-18T10:00:00.000Z"),
  });

  const initial = await service.snapshot({ contactId: fake.contact.id });
  assert.equal(initial.runtime, "agent-core");
  assert.equal(initial.settings.prompt, DEFAULT_SUZU_COMPACTION_PROMPT);
  assert.deepEqual(initial.settings.automatic, { enabled: false, tokenThreshold: 32_000, retainTokens: 8_000 });
  assert.deepEqual(initial.settings.manual, { retainTokens: 8_000 });
  assert.equal(initial.selectedConversation.hasTranscript, true);

  const saved = await service.save({
    contactId: fake.contact.id,
    prompt: "用温柔的第一人称保留关系、承诺和未完话题。",
    automatic: { enabled: true, tokenThreshold: 18_000, retainTokens: 6_000 },
    manual: { retainTokens: 4_000 },
  });
  assert.equal(saved.settings.prompt, "用温柔的第一人称保留关系、承诺和未完话题。");
  assert.deepEqual(saved.settings.automatic, { enabled: true, tokenThreshold: 18_000, retainTokens: 6_000 });
  assert.deepEqual(saved.settings.manual, { retainTokens: 4_000 });
  const runtimeSettings = await service.settingsForRuntime({ sessionId: fake.contact.sessionId });
  assert.equal(runtimeSettings.available, true);
  assert.equal(runtimeSettings.prompt, saved.settings.prompt);
  assert.deepEqual(runtimeSettings.manual, { retainTokens: 4_000 });

  const completed = await service.run({ contactId: fake.contact.id, manual: { retainTokens: 3_000 } });
  assert.deepEqual(fake.calls.runCompaction, [{
    sessionId: fake.contact.sessionId,
    contactId: fake.contact.id,
    cwd: fake.projectRoot,
  }]);
  assert.equal(completed.settings.manual.retainTokens, 3_000);
  assert.equal(completed.lastRun.status, "completed");
  assert.match(completed.latestSummary, /一起挑游戏/u);
  assert.equal(completed.selectedConversation.hasTranscript, true, "model-only replacement does not erase raw transcript evidence");
  const persisted = JSON.parse(await fs.readFile(path.join(fake.projectRoot, ".suzu-lives", "compactor.json"), "utf8"));
  assert.equal(persisted.manual.retainTokens, 3_000);
  assert.equal(persisted.automatic.tokenThreshold, 18_000);
});

test("Agent compactor rejects an impossible automatic tail and never falls back to legacy history", async () => {
  const root = await temporaryRoot();
  const fake = fixture(root, { hasHistory: false });
  await fs.mkdir(fake.projectRoot, { recursive: true });
  const service = createConversationCompactorService({ reader: fake.reader, runtime: fake.runtime });
  await assert.rejects(
    service.save({ contactId: fake.contact.id, automatic: { enabled: true, tokenThreshold: 5_000, retainTokens: 5_000 } }),
    (error) => error?.code === "INVALID_COMPACTOR_SETTING",
  );
  await assert.rejects(
    service.run({ contactId: fake.contact.id }),
    (error) => error?.code === "NO_COMPACTABLE_HISTORY",
  );
  assert.deepEqual(fake.calls.runCompaction, []);
});

test("Agent compactor refuses to report success for an accepted but unfinished native command", async () => {
  const root = await temporaryRoot();
  const fake = fixture(root);
  await fs.mkdir(fake.projectRoot, { recursive: true });
  fake.runtime.runCompaction = async (value) => {
    fake.calls.runCompaction.push(value);
    return { accepted: true, completed: false, reason: "NO_COMPACTABLE_HISTORY" };
  };
  const service = createConversationCompactorService({ reader: fake.reader, runtime: fake.runtime });

  await assert.rejects(
    service.run({ contactId: fake.contact.id }),
    (error) => error?.code === "AGENT_COMPACTION_NOT_COMPLETED",
  );
  assert.equal(fake.calls.runCompaction.length, 1);
});
