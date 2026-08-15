import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SESSION_COMPACTION_SCHEMA,
  chooseCompactionPlan,
  chooseTokenTailCompactionPlan,
  importConversationHistory,
  parseJsonlText,
  parseSessionCompaction,
  reconstructLogicalContext,
  runCompaction,
} from "../src/index.mjs";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function record({
  uuid,
  parentUuid = null,
  type,
  role,
  content,
  timestamp,
  usage = undefined,
}) {
  return {
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: "C:\\agent",
    sessionId: "session-test",
    version: "2.0.0",
    type,
    message: {
      role,
      content,
      ...(usage ? { usage } : {}),
    },
    uuid,
    timestamp,
  };
}

function sampleTranscript() {
  return [
    record({
      uuid: "old-user",
      type: "user",
      role: "user",
      content: "我昨天去了科技馆。",
      timestamp: "2026-07-01T08:00:00.000Z",
    }),
    record({
      uuid: "old-agent",
      parentUuid: "old-user",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "你看了什么展览？" }],
      timestamp: "2026-07-01T08:01:00.000Z",
      usage: { input_tokens: 12_000 },
    }),
    record({
      uuid: "recent-user",
      parentUuid: "old-agent",
      type: "user",
      role: "user",
      content: "刚才说到哪了？",
      timestamp: "2026-07-30T01:00:00.000Z",
    }),
    record({
      uuid: "recent-agent",
      parentUuid: "recent-user",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "说到你今天的安排。" }],
      timestamp: "2026-07-30T01:01:00.000Z",
      usage: { input_tokens: 20_000 },
    }),
  ];
}

function writeTranscript(filePath, records = sampleTranscript()) {
  fs.writeFileSync(
    filePath,
    `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
}

test("rejects a blank transcript path instead of resolving the working directory", async () => {
  await assert.rejects(
    runCompaction({
      transcriptPath: " ",
      agentId: "agent-test",
      softwareDataDirectory: temporaryDirectory("suzu-conversation-compactor-path-"),
      dryRun: true,
    }),
    /需要 transcriptPath/,
  );
});

test("keeps recent raw dialogue and chooses a complete user boundary", () => {
  const entries = parseJsonlText(
    `${sampleTranscript().map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
  const context = reconstructLogicalContext(entries);
  const plan = chooseCompactionPlan(
    context,
    new Date("2026-07-30T02:00:00.000Z"),
  );
  assert.equal(plan.action, "compact");
  assert.equal(plan.mode, "recent-hours");
  assert.equal(plan.head.record.uuid, "recent-user");
  assert.deepEqual(
    plan.preservedLogical.map((entry) => entry.record.uuid),
    ["recent-user", "recent-agent"],
  );
});

test("token-tail compaction uses the requested retained tail and only passes an exceeded token threshold", () => {
  const entries = parseJsonlText(
    `${sampleTranscript().map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
  const context = reconstructLogicalContext(entries);
  const manual = chooseTokenTailCompactionPlan(context, { recentRawTokensToKeep: 1 });
  assert.equal(manual.action, "compact");
  assert.equal(manual.mode, "token-tail");
  assert.equal(manual.head.record.uuid, "recent-user");
  assert.deepEqual(manual.preservedLogical.map((entry) => entry.record.uuid), ["recent-user", "recent-agent"]);

  const waiting = chooseTokenTailCompactionPlan(context, {
    minimumContextTokens: 20_000,
    recentRawTokensToKeep: 1,
  });
  assert.equal(waiting.action, "skip");
  assert.match(waiting.reason, /未超过 20000/u);
});

test("accepts only a nonempty session summary", () => {
  assert.deepEqual(parseSessionCompaction('{"summary":"继续讨论科技馆。"}'), {
    summary: "继续讨论科技馆。",
  });
  assert.throws(
    () => parseSessionCompaction({ summary: "继续讨论", memories: [] }),
    /只能包含 summary/u,
  );
  assert.throws(
    () => parseSessionCompaction({ summary: " " }),
    /空 summary/u,
  );
});

test("writes a conversation checkpoint without opening or writing a long-term memory database", async () => {
  const root = temporaryDirectory("suzu-conversation-compactor-");
  const transcriptPath = path.join(root, "session.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  writeTranscript(transcriptPath);
  let request = null;

  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory,
    memoryOwner: "Suzu",
    userName: "用户",
    now: new Date("2026-07-30T02:00:00.000Z"),
    generator: async (value) => {
      request = value;
      return {
        output: { summary: "我记得用户昨天去了科技馆，并问过他看了什么展览。" },
        usage: { input_tokens: 12, output_tokens: 8 },
        model: "test-model",
        requestId: "compaction-request",
        durationMs: 1,
        metadata: { provider: "test" },
      };
    },
  });

  assert.equal(result.status, "written");
  assert.equal(result.messagesCompacted, 2);
  assert.equal(result.usageRecorded, true);
  assert.equal(request.schemaName, "conversation-compaction-v1");
  assert.deepEqual(request.schema, SESSION_COMPACTION_SCHEMA);
  assert.doesNotMatch(request.input, /M0001/u);
  assert.ok(fs.existsSync(result.backupPath));
  assert.equal(
    fs.existsSync(path.join(softwareDataDirectory, "agents", "agent-test", "memory", "memory.db")),
    false,
  );

  const appended = parseJsonlText(fs.readFileSync(transcriptPath, "utf8"));
  assert.equal(appended.at(-2).record.subtype, "compact_boundary");
  assert.equal(appended.at(-1).record.isCompactSummary, true);
  assert.match(appended.at(-1).record.message.content, /<conversation_summary>/u);
  assert.doesNotMatch(appended.at(-1).record.message.content, /<first_person_memory>/u);
  assert.match(
    fs.readFileSync(path.join(softwareDataDirectory, "agents", "agent-test", "memory", "compactor", "work", "latest-summary.md"), "utf8"),
    /科技馆/u,
  );
});

test("imports a separate JSONL by replacing the target session without changing the source file", async () => {
  const root = temporaryDirectory("suzu-conversation-history-import-");
  const sourceTranscriptPath = path.join(root, "source.jsonl");
  const targetTranscriptPath = path.join(root, "target.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  const source = sampleTranscript();
  source[0].message.content = "我之前和你聊过第一次一起看流星雨。";
  source[1].message.content = [{ type: "text", text: "我记得那天我们都很开心。" }];
  writeTranscript(sourceTranscriptPath, source);
  writeTranscript(targetTranscriptPath);
  const originalSource = fs.readFileSync(sourceTranscriptPath, "utf8");
  const originalTarget = fs.readFileSync(targetTranscriptPath, "utf8");

  const result = await importConversationHistory({
    sourceTranscriptPath,
    transcriptPath: targetTranscriptPath,
    agentId: "agent-test",
    sessionId: "target-session",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    targetProjectRoot: path.join(root, "target-contact"),
  });

  assert.equal(result.status, "imported");
  assert.equal(result.mode, "replace");
  assert.equal(fs.readFileSync(sourceTranscriptPath, "utf8"), originalSource);
  const targetText = fs.readFileSync(targetTranscriptPath, "utf8");
  assert.doesNotMatch(targetText, /科技馆/u);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), originalTarget);
  const targetEntries = parseJsonlText(targetText, targetTranscriptPath);
  assert.equal(targetEntries.length, source.length);
  assert.deepEqual(targetEntries.map((entry) => entry.record.uuid), source.map((entry) => entry.uuid));
  assert.deepEqual(targetEntries.map((entry) => entry.record.parentUuid), source.map((entry) => entry.parentUuid));
  assert.equal(targetEntries.every((entry) => entry.record.sessionId === "target-session"), true);
  assert.equal(targetEntries.every((entry) => entry.record.cwd === path.join(root, "target-contact")), true);
  assert.deepEqual(
    reconstructLogicalContext(targetEntries).logical.map((entry) => entry.record.uuid),
    source.map((entry) => entry.uuid),
  );
});

test("dry runs without invoking a generator or creating a long-term memory database", async () => {
  const root = temporaryDirectory("suzu-conversation-compactor-dry-run-");
  const transcriptPath = path.join(root, "session.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  writeTranscript(transcriptPath);
  let generatorCalls = 0;

  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    dryRun: true,
    generator: async () => { generatorCalls += 1; },
  });

  assert.equal(result.status, "dry-run");
  assert.equal(result.messagesToCompact, 2);
  assert.equal(generatorCalls, 0);
  assert.equal(
    fs.existsSync(path.join(softwareDataDirectory, "agents", "agent-test", "memory", "memory.db")),
    false,
  );
});

test("keeps compactor reports separate when two Claude sessions use the same Agent", async () => {
  const root = temporaryDirectory("suzu-conversation-compactor-sessions-");
  const softwareDataDirectory = path.join(root, "software-data");
  const firstTranscript = path.join(root, "first.jsonl");
  const secondTranscript = path.join(root, "second.jsonl");
  writeTranscript(firstTranscript);
  writeTranscript(secondTranscript);

  await runCompaction({
    transcriptPath: firstTranscript,
    agentId: "agent-test",
    sessionId: "session-first",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    dryRun: true,
  });
  await runCompaction({
    transcriptPath: secondTranscript,
    agentId: "agent-test",
    sessionId: "session-second",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    dryRun: true,
  });

  const workRoot = path.join(softwareDataDirectory, "agents", "agent-test", "memory", "compactor", "sessions");
  const firstReport = JSON.parse(fs.readFileSync(path.join(workRoot, "session-first", "work", "last-run.json"), "utf8"));
  const secondReport = JSON.parse(fs.readFileSync(path.join(workRoot, "session-second", "work", "last-run.json"), "utf8"));
  assert.equal(firstReport.sessionId, "session-first");
  assert.equal(secondReport.sessionId, "session-second");
  assert.equal(fs.existsSync(path.join(softwareDataDirectory, "agents", "agent-test", "memory", "compactor", "work", "last-run.json")), false);
});
