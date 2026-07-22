import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function record({ uuid, parentUuid = null, type, content, timestamp, usage = null }) {
  const shared = {
    uuid,
    parentUuid,
    type,
    timestamp,
    sessionId: "synthetic-session",
    cwd: "C:/synthetic/project",
    version: "test",
    isSidechain: false,
  };
  if (type === "user") return { ...shared, message: { role: "user", content } };
  return {
    ...shared,
    message: {
      role: "assistant",
      content: [{ type: "text", text: content }],
      ...(usage ? { usage } : {}),
    },
  };
}

test("压缩、备份、摘要注入和 RAG 归档形成完整事务", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-integration-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memoryRoot = path.join(directory, "memory");
  fs.cpSync(path.join(repositoryRoot, "memory"), memoryRoot, { recursive: true });

  const transcriptPath = path.join(directory, "session.jsonl");
  const summaryPath = path.join(directory, "summary.md");
  const compactorConfigPath = path.join(directory, "compactor.json");
  const ragConfigPath = path.join(directory, "rag.json");
  const historyPath = path.join(directory, "history.jsonl");
  const sourceRecords = [
    record({ uuid: "u-old", type: "user", content: "三天前我们约好周六去看海。", timestamp: "2026-07-13T08:00:00.000Z" }),
    record({ uuid: "a-old", parentUuid: "u-old", type: "assistant", content: "我会记得带蓝色保温杯。", timestamp: "2026-07-13T08:00:05.000Z" }),
    record({ uuid: "u-new", parentUuid: "a-old", type: "user", content: "昨晚我有一点失眠。", timestamp: "2026-07-15T18:00:00.000Z" }),
    record({ uuid: "a-new", parentUuid: "u-new", type: "assistant", content: "今天早点休息。", timestamp: "2026-07-15T18:00:05.000Z", usage: { input_tokens: 8000 } }),
  ];
  fs.writeFileSync(transcriptPath, `${sourceRecords.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.writeFileSync(summaryPath, "我记得我们约好周六去看海，我会带蓝色保温杯。\n", "utf8");
  fs.writeFileSync(compactorConfigPath, JSON.stringify({
    transcriptPath,
    claudeCommand: "claude",
    claudeArgs: [],
    model: "",
    memoryOwner: "Agent",
    userName: "用户",
    promptFile: path.join(memoryRoot, "manual_compactor", "prompt.md"),
    boundaryContextMessages: 20,
    rules: {
      minimumHoursSinceLastCompaction: 24,
      recentRawHoursToKeep: 24,
      contextTokensTrigger: 15000,
      recentRawTokensToKeep: 5000,
    },
    inheritClaudeSettingsEnv: false,
    llmEnv: {},
  }), "utf8");
  fs.writeFileSync(ragConfigPath, JSON.stringify({
    historyFile: historyPath,
    retrieval: { maxTurnGapHours: 2 },
    embedding: { enabled: false, indexFile: path.join(directory, "embeddings.jsonl") },
  }), "utf8");

  const run = spawnSync(process.execPath, [
    path.join(memoryRoot, "manual_compactor", "compact-jsonl.mjs"),
    `--config=${compactorConfigPath}`,
    `--summary-file=${summaryPath}`,
    "--now=2026-07-16T12:00:00.000Z",
  ], {
    encoding: "utf8",
    env: { ...process.env, RAG_CONFIG: ragConfigPath },
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, "written");
  assert.equal(report.mode, "recent-hours");
  assert.equal(report.ragMessagesAdded, 2);
  assert.equal(report.eventMemoriesAdded, 0);
  assert.equal(report.eventMemoryWarning, undefined);
  assert.ok(fs.existsSync(report.backupPath));

  const written = fs.readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(written.at(-2).subtype, "compact_boundary");
  assert.equal(written.at(-1).isCompactSummary, true);
  assert.match(written.at(-1).message.content, /<first_person_memory>/u);
  assert.match(written.at(-1).message.content, /蓝色保温杯/u);

  const history = fs.readFileSync(historyPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(history.map((item) => item.role), ["user", "assistant"]);
  assert.match(history[0].text, /周六去看海/u);
  assert.match(history[1].text, /蓝色保温杯/u);
  assert.doesNotMatch(history.map((item) => item.text).join("\n"), /失眠/u);
});

test("Schema 不兼容时回退，残缺 JSON 会留档并重试一次", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-structured-output-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memoryRoot = path.join(directory, "memory");
  fs.cpSync(path.join(repositoryRoot, "memory"), memoryRoot, { recursive: true });

  const transcriptPath = path.join(directory, "session.jsonl");
  const compactorConfigPath = path.join(directory, "compactor.json");
  const ragConfigPath = path.join(directory, "rag.json");
  const historyPath = path.join(directory, "history.jsonl");
  const fakeClaudePath = path.join(directory, "fake-claude.mjs");
  const counterPath = path.join(directory, "attempt.txt");
  const sourceRecords = [
    record({ uuid: "u-old", type: "user", content: "三天前我们约好周六去看海。", timestamp: "2026-07-13T08:00:00.000Z" }),
    record({ uuid: "a-old", parentUuid: "u-old", type: "assistant", content: "我会带蓝色保温杯。", timestamp: "2026-07-13T08:00:05.000Z" }),
    record({ uuid: "u-new", parentUuid: "a-old", type: "user", content: "近期原文继续保留。", timestamp: "2026-07-15T18:00:00.000Z" }),
    record({ uuid: "a-new", parentUuid: "u-new", type: "assistant", content: "好。", timestamp: "2026-07-15T18:00:05.000Z", usage: { input_tokens: 8000 } }),
  ];
  fs.writeFileSync(transcriptPath, `${sourceRecords.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.writeFileSync(fakeClaudePath, `
import fs from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const attempt = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8") : "0") + 1;
fs.writeFileSync(counterPath, String(attempt), "utf8");
if (process.argv.includes("--json-schema")) {
  process.stderr.write("output_config is not supported by this provider");
  process.exit(2);
}
if (attempt === 2) {
  process.stdout.write(JSON.stringify({ result: '{"summary":"残缺结果","events":[]' }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  result: JSON.stringify({ summary: "我记得周六看海的约定。", events: [] })
}));
`, "utf8");
  fs.writeFileSync(compactorConfigPath, JSON.stringify({
    transcriptPath,
    claudeCommand: process.execPath,
    claudeArgs: [fakeClaudePath],
    memoryOwner: "Agent",
    userName: "对方",
    promptFile: path.join(memoryRoot, "manual_compactor", "prompt.md"),
    boundaryContextMessages: 20,
    structuredOutput: "auto",
    maxLlmAttempts: 2,
    rules: {
      minimumHoursSinceLastCompaction: 24,
      recentRawHoursToKeep: 24,
      contextTokensTrigger: 15000,
      recentRawTokensToKeep: 5000,
    },
    inheritClaudeSettingsEnv: false,
    llmEnv: {},
  }), "utf8");
  fs.writeFileSync(ragConfigPath, JSON.stringify({
    historyFile: historyPath,
    retrieval: { maxTurnGapHours: 2 },
    embedding: { enabled: false, indexFile: path.join(directory, "embeddings.jsonl") },
  }), "utf8");

  const run = spawnSync(process.execPath, [
    path.join(memoryRoot, "manual_compactor", "compact-jsonl.mjs"),
    `--config=${compactorConfigPath}`,
    "--now=2026-07-16T12:00:00.000Z",
  ], {
    encoding: "utf8",
    env: { ...process.env, RAG_CONFIG: ragConfigPath },
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.llmAttempts, 3);
  assert.equal(report.llmOutputMode, "prompt-json");
  assert.equal(report.llmSchemaFallback, true);
  assert.equal(fs.readFileSync(counterPath, "utf8"), "3");
  const failedOutputs = fs.readdirSync(path.join(memoryRoot, "manual_compactor", "work"))
    .filter((name) => name.startsWith("failed-output-"));
  assert.equal(failedOutputs.length, 2);
  const failures = failedOutputs.map((name) => JSON.parse(
    fs.readFileSync(path.join(memoryRoot, "manual_compactor", "work", name), "utf8"),
  ));
  assert.deepEqual(failures.map((item) => item.outputMode).sort(), ["json-schema", "prompt-json"]);
  assert.ok(failures.some((item) => item.rawOutput.includes("残缺结果")));
});

test("同一次 LLM 调用生成摘要和带真实来源的事件记忆", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-events-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memoryRoot = path.join(directory, "memory");
  fs.cpSync(path.join(repositoryRoot, "memory"), memoryRoot, { recursive: true });

  const transcriptPath = path.join(directory, "session.jsonl");
  const compactorConfigPath = path.join(directory, "compactor.json");
  const ragConfigPath = path.join(directory, "rag.json");
  const historyPath = path.join(directory, "history.jsonl");
  const eventsPath = path.join(directory, "events.jsonl");
  const fakeClaudePath = path.join(directory, "fake-claude.mjs");
  const sourceRecords = [
    record({ uuid: "u-old", type: "user", content: "三天前我们约好周六去看海。", timestamp: "2026-07-13T08:00:00.000Z" }),
    record({ uuid: "a-old", parentUuid: "u-old", type: "assistant", content: "我会记得带蓝色保温杯。", timestamp: "2026-07-13T08:00:05.000Z" }),
    record({ uuid: "u-new", parentUuid: "a-old", type: "user", content: "昨晚我有一点失眠。", timestamp: "2026-07-15T18:00:00.000Z" }),
    record({ uuid: "a-new", parentUuid: "u-new", type: "assistant", content: "今天早点休息。", timestamp: "2026-07-15T18:00:05.000Z", usage: { input_tokens: 8000 } }),
  ];
  fs.writeFileSync(transcriptPath, `${sourceRecords.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.writeFileSync(fakeClaudePath, `
const memory = {
  summary: "我记得我们约好周六去看海，我会带蓝色保温杯。",
  events: [{
    title: "周六看海",
    text: "我和对方约好周六去看海，我会带蓝色保温杯。",
    event_date: "2026-07-18",
    status: "ongoing",
    source_refs: ["M0001", "M0002"]
  }]
};
const maxTurnsIndex = process.argv.indexOf("--max-turns");
if (process.argv.includes("--json-schema") && process.argv[maxTurnsIndex + 1] !== "2") {
  process.stderr.write(JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    stop_reason: "tool_use",
    terminal_reason: "max_turns",
    errors: ["Reached maximum number of turns (1)"]
  }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ structured_output: memory, result: JSON.stringify(memory) }));
`, "utf8");
  fs.writeFileSync(compactorConfigPath, JSON.stringify({
    transcriptPath,
    claudeCommand: process.execPath,
    claudeArgs: [fakeClaudePath],
    memoryOwner: "Agent",
    userName: "对方",
    promptFile: path.join(memoryRoot, "manual_compactor", "prompt.md"),
    boundaryContextMessages: 20,
    rules: {
      minimumHoursSinceLastCompaction: 24,
      recentRawHoursToKeep: 24,
      contextTokensTrigger: 15000,
      recentRawTokensToKeep: 5000,
    },
    inheritClaudeSettingsEnv: false,
    llmEnv: {},
  }), "utf8");
  fs.writeFileSync(ragConfigPath, JSON.stringify({
    historyFile: historyPath,
    eventsFile: eventsPath,
    retrieval: { maxTurnGapHours: 2 },
    eventGeneration: { enabled: true, maxEventsPerCompaction: 10, maxEventChars: 800 },
    embedding: { enabled: false, indexFile: path.join(directory, "embeddings.jsonl") },
  }), "utf8");

  const run = spawnSync(process.execPath, [
    path.join(memoryRoot, "manual_compactor", "compact-jsonl.mjs"),
    `--config=${compactorConfigPath}`,
    "--now=2026-07-16T12:00:00.000Z",
  ], {
    encoding: "utf8",
    env: { ...process.env, RAG_CONFIG: ragConfigPath },
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.llmAttempts, 1);
  assert.equal(report.llmOutputMode, "json-schema");
  assert.equal(report.llmSchemaFallback, false);
  assert.equal(report.eventMemoriesAdded, 1);
  assert.equal(report.eventMemoryWarning, undefined);
  const events = fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].memory_type, "event");
  assert.equal(events[0].status, "ongoing");
  assert.equal(events[0].event_date, "2026-07-18");
  assert.equal(events[0].generator_version, 2);
  assert.deepEqual(events[0].source_uuids, ["u-old", "a-old"]);
  assert.equal(events[0].compaction_batch_uuid, report.boundaryUuid);

  // 事件库属于可重新生成的派生数据；它损坏时，主 compact 和原文 history 仍应成功。
  const secondTranscriptPath = path.join(directory, "second-session.jsonl");
  const secondRecords = [
    record({ uuid: "u2-old", type: "user", content: "三天前我们还约好带相机。", timestamp: "2026-07-13T09:00:00.000Z" }),
    record({ uuid: "a2-old", parentUuid: "u2-old", type: "assistant", content: "我会提前充电。", timestamp: "2026-07-13T09:00:05.000Z" }),
    record({ uuid: "u2-new", parentUuid: "a2-old", type: "user", content: "昨晚的话继续留在近期。", timestamp: "2026-07-15T19:00:00.000Z" }),
    record({ uuid: "a2-new", parentUuid: "u2-new", type: "assistant", content: "好。", timestamp: "2026-07-15T19:00:05.000Z", usage: { input_tokens: 8000 } }),
  ];
  fs.writeFileSync(secondTranscriptPath, `${secondRecords.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.writeFileSync(eventsPath, "not-json\n", "utf8");
  const secondConfig = JSON.parse(fs.readFileSync(compactorConfigPath, "utf8"));
  secondConfig.transcriptPath = secondTranscriptPath;
  fs.writeFileSync(compactorConfigPath, JSON.stringify(secondConfig), "utf8");
  const failedEventRun = spawnSync(process.execPath, [
    path.join(memoryRoot, "manual_compactor", "compact-jsonl.mjs"),
    `--config=${compactorConfigPath}`,
    "--now=2026-07-16T12:00:00.000Z",
  ], {
    encoding: "utf8",
    env: { ...process.env, RAG_CONFIG: ragConfigPath },
  });
  assert.equal(failedEventRun.status, 0, failedEventRun.stderr || failedEventRun.stdout);
  const failedEventReport = JSON.parse(failedEventRun.stdout);
  assert.equal(failedEventReport.status, "written");
  assert.equal(failedEventReport.eventMemoriesAdded, 0);
  assert.match(failedEventReport.eventMemoryWarning, /events\.jsonl/u);
  const secondWritten = fs.readFileSync(secondTranscriptPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(secondWritten.at(-1).isCompactSummary, true);
  const combinedHistory = fs.readFileSync(historyPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(combinedHistory.length, 4);
});
