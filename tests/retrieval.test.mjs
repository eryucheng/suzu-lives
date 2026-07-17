import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEmbeddingChunks } from "../memory/rag/embedding.mjs";
import {
  buildMemoryUnits,
  buildTurns,
  classifyRecallIntent,
  loadRagConfig,
  readHistory,
  resolveTemporalQuery,
  retrieveMemories,
} from "../memory/rag/retrieve.mjs";

const messages = [
  { id: "u1", role: "user", speaker: "用户", timestamp: "2026-07-01T08:00:00.000Z", text: "周六看海时记得带东西。" },
  { id: "u2", role: "user", speaker: "用户", timestamp: "2026-07-01T08:00:02.000Z", text: "天气可能有点冷。" },
  { id: "a1", role: "assistant", speaker: "Agent", timestamp: "2026-07-01T08:00:05.000Z", text: "我会带蓝色保温杯和外套。" },
  { id: "u3", role: "user", speaker: "用户", timestamp: "2026-07-02T10:00:00.000Z", text: "晚餐吃什么？" },
  { id: "a2", role: "assistant", speaker: "Agent", timestamp: "2026-07-02T10:00:03.000Z", text: "可以煮番茄面。" },
];

test("精简配置默认读取通用 Embedding 环境变量", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-embedding-env-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "rag.json");
  fs.writeFileSync(configPath, JSON.stringify({
    historyFile: "history.jsonl",
    embedding: { enabled: true },
  }), "utf8");

  const config = loadRagConfig(configPath);
  assert.equal(config.embedding.apiKeyEnv, "EMBEDDING_API_KEY");
});

test("连续用户消息和助手回复组成一个双方对话轮", () => {
  const turns = buildTurns(messages, 2);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].messages.map((item) => item.id), ["u1", "u2", "a1"]);
  assert.deepEqual(turns[1].messages.map((item) => item.id), ["u3", "a2"]);
});

test("加入事件后原有原话向量 chunk id 保持不变", () => {
  const config = { maxInputChars: 6000, chunkOverlapChars: 200, documentPrefix: "" };
  const oldChunks = buildEmbeddingChunks(buildTurns(messages, 2), config);
  const units = buildMemoryUnits(messages, [{
    id: "event:sea",
    memory_type: "event",
    title: "周六看海",
    text: "我记得我们约好周六去看海。",
    event_date: "2026-07-04",
    source_start_timestamp: "2026-07-01T08:00:00.000Z",
    source_end_timestamp: "2026-07-01T08:00:05.000Z",
    source_ids: ["u1", "a1"],
    source_uuids: [],
    status: "ongoing",
    generator_version: 2,
  }], 2);
  const newChunks = buildEmbeddingChunks(units, config);
  assert.deepEqual(
    newChunks.slice(0, oldChunks.length).map((item) => item.chunkId),
    oldChunks.map((item) => item.chunkId),
  );
  assert.equal(newChunks.length, oldChunks.length + 1);
});

test("读取旧历史时排除自动化和合成当前时间整轮", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-history-filter-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.jsonl");
  const rows = [
    { id: "time-u", role: "user", text: "你知道现在是7月16日上午10点30分" },
    { id: "time-a", role: "assistant", text: "现在是上午十点半。" },
    { id: "real-u", role: "user", text: "以前我们约好去看海。" },
    { id: "real-a", role: "assistant", text: "我记得。" },
  ];
  fs.writeFileSync(historyPath, `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  assert.deepEqual(readHistory(historyPath).map((item) => item.id), ["real-u", "real-a"]);
});

test("原话召回只返回最相关的一句，无关或泛化问题不注入", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-rag-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.jsonl");
  const eventsPath = path.join(directory, "events.jsonl");
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(historyPath, `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.writeFileSync(eventsPath, "", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    historyFile: "history.jsonl",
    eventsFile: "events.jsonl",
    retrieval: {
      maxFragments: 1,
      neighborTurns: 0,
      maxTurnGapHours: 2,
      maxContextChars: 2500,
      maxMessageChars: 1000,
      minimumScore: 0,
      relativeScoreFloor: 0,
    },
    embedding: { enabled: false },
    eligibility: { strongBm25Score: 0.1, strongBm25Overlap: 1 },
    injection: { heading: "你想起了之前的片段：", guidance: "只作为回忆依据。" },
  }), "utf8");

  const result = await retrieveMemories("蓝色保温杯", loadRagConfig(configPath));
  assert.equal(result.fragments.length, 1);
  assert.match(result.context, /Agent：/u);
  assert.match(result.context, /蓝色保温杯/u);
  assert.doesNotMatch(result.context, /用户：/u);
  assert.doesNotMatch(result.context, /番茄面/u);

  const unrelated = await retrieveMemories("量子火箭燃料", loadRagConfig(configPath));
  assert.equal(unrelated.fragments.length, 0);
  assert.equal(unrelated.context, "");

  const generic = await retrieveMemories("在吗", loadRagConfig(configPath));
  assert.equal(generic.retrievalMode, "skipped");
  assert.equal(generic.vector.status, "not-run");
  assert.equal(generic.context, "");

  const ambiguous = await retrieveMemories("还记得那件事吗", loadRagConfig(configPath));
  assert.equal(ambiguous.skippedReason, "no-recall-topic");
  assert.equal(ambiguous.vector.status, "not-run");
  assert.equal(ambiguous.context, "");
});

test("询问事件时只返回事件概括", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-event-rag-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "history.jsonl"), `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const eventRows = [
    {
      id: "event:old-sea",
      memory_type: "event",
      text: "我记得很早以前也提到过看海，但具体日期不清楚。",
      event_date: null,
      source_start_timestamp: "2026-07-01T08:00:00.000Z",
      source_end_timestamp: "2026-07-01T08:00:00.000Z",
      status: "resolved",
      source_ids: ["u1"],
      source_uuids: [],
      generator_version: 2,
    },
    {
      id: "event:sea",
      memory_type: "event",
      text: "我记得我们约好周六去看海，我答应带蓝色保温杯和外套。",
      event_date: "2026-07-04",
      source_start_timestamp: "2026-07-01T08:00:00.000Z",
      source_end_timestamp: "2026-07-01T08:00:05.000Z",
      status: "ongoing",
      source_ids: ["u1", "a1"],
      source_uuids: [],
      generator_version: 2,
    },
  ];
  fs.writeFileSync(
    path.join(directory, "events.jsonl"),
    `${eventRows.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    historyFile: "history.jsonl",
    eventsFile: "events.jsonl",
    embedding: { enabled: false },
    eligibility: { strongBm25Score: 0.1, strongBm25Overlap: 1 },
    injection: { heading: "你想起了之前的片段：", guidance: "只作为回忆依据。" },
  }), "utf8");

  const result = await retrieveMemories("那次看海后来发生了什么", loadRagConfig(configPath));
  assert.equal(result.recallIntent, "event");
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0].memoryType, "event");
  assert.match(result.context, /事件日期：2026-07-04/u);
  assert.match(result.context, /我记得我们约好周六去看海/u);
  assert.doesNotMatch(result.context, /用户：/u);

  const byDate = await retrieveMemories("2026年7月4日发生了什么", loadRagConfig(configPath));
  assert.equal(byDate.fragments[0]?.memoryType, "event-day-summary");
  assert.match(byDate.context, /当日记忆（2026-07-04）/u);
});

test("相对日期会确定性换算，并按日期生成一个事件片段", async (context) => {
  const now = "2026-07-16T04:00:00.000Z";
  assert.deepEqual(
    resolveTemporalQuery("我上周六去干啥了", now, "Asia/Shanghai"),
    {
      matched: true,
      kind: "day",
      expression: "上周六",
      startDate: "2026-07-11",
      endDate: "2026-07-11",
      remainingQuery: "我 去干啥了",
    },
  );
  assert.equal(resolveTemporalQuery("三天前吃了什么", now, "Asia/Shanghai").startDate, "2026-07-13");
  assert.deepEqual(
    resolveTemporalQuery("上周末做了什么", now, "Asia/Shanghai"),
    {
      matched: true,
      kind: "range",
      expression: "上周末",
      startDate: "2026-07-11",
      endDate: "2026-07-12",
      remainingQuery: "做了什么",
    },
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-temporal-rag-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "history.jsonl"), "", "utf8");
  const eventRows = [
    {
      id: "event:museum",
      memory_type: "event",
      title: "去了科技馆",
      text: "我记得对方去了科技馆看机器人展览。",
      event_date: "2026-07-11",
      source_start_timestamp: "2026-07-11T04:00:00.000Z",
      source_end_timestamp: "2026-07-11T08:00:00.000Z",
      status: "resolved",
      source_ids: ["museum-source"],
      source_uuids: [],
      generator_version: 2,
    },
    {
      id: "event:game",
      memory_type: "event",
      title: "晚上一起玩游戏",
      text: "我记得晚上我们一起玩了一局游戏。",
      event_date: "2026-07-11",
      source_start_timestamp: "2026-07-11T12:00:00.000Z",
      source_end_timestamp: "2026-07-11T13:00:00.000Z",
      status: "resolved",
      source_ids: ["game-source"],
      source_uuids: [],
      generator_version: 2,
    },
    {
      id: "event:sunday",
      memory_type: "event",
      title: "周日吃面",
      text: "我记得周日吃了番茄面。",
      event_date: "2026-07-12",
      source_start_timestamp: "2026-07-12T04:00:00.000Z",
      source_end_timestamp: "2026-07-12T04:30:00.000Z",
      status: "resolved",
      source_ids: ["sunday-source"],
      source_uuids: [],
      generator_version: 2,
    },
  ];
  fs.writeFileSync(
    path.join(directory, "events.jsonl"),
    `${eventRows.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    historyFile: "history.jsonl",
    eventsFile: "events.jsonl",
    embedding: { enabled: false },
    eligibility: { strongBm25Score: 0.1, strongBm25Overlap: 1 },
    recall: { temporalMaxEvents: 8, temporalMaxChars: 1400 },
    injection: { heading: "你想起了之前的片段：", guidance: "只作为回忆依据。" },
  }), "utf8");
  const config = loadRagConfig(configPath);

  const broad = await retrieveMemories("我上周六去干啥了", config, { now });
  assert.equal(broad.retrievalMode, "date-filter");
  assert.equal(broad.vector.status, "not-run");
  assert.equal(broad.fragments.length, 1);
  assert.equal(broad.fragments[0].memoryType, "event-day-summary");
  assert.equal(broad.fragments[0].eventCount, 2);
  assert.match(broad.context, /2026-07-11/u);
  assert.match(broad.context, /科技馆/u);
  assert.match(broad.context, /一起玩游戏/u);
  assert.doesNotMatch(broad.context, /番茄面/u);

  const topical = await retrieveMemories("我上周六去科技馆了吗", config, { now });
  assert.equal(topical.fragments.length, 1);
  assert.equal(topical.fragments[0].memoryType, "event");
  assert.match(topical.context, /科技馆/u);
  assert.doesNotMatch(topical.context, /一起玩游戏/u);

  const explicit = await retrieveMemories("2026年7月11日发生了什么", config, { now });
  assert.equal(explicit.fragments[0]?.memoryType, "event-day-summary");
  assert.equal(explicit.fragments[0]?.eventCount, 2);

  const missing = await retrieveMemories("我上周五去干啥了", config, { now });
  assert.equal(missing.context, "");
  assert.equal(missing.fragments.length, 0);
});

test("事件库没有命中时用至多三条双方原话作为一个证据片段", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-event-fallback-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const museumMessages = [
    { id: "m-u1", role: "user", speaker: "用户", timestamp: "2026-07-03T12:00:00.000Z", text: "明天我们去科技馆吧。" },
    { id: "m-a1", role: "assistant", speaker: "Suzu", timestamp: "2026-07-03T12:00:05.000Z", text: "好，明天一起去科技馆，我会记住路线。" },
    { id: "m-u2", role: "user", speaker: "用户", timestamp: "2026-07-04T08:00:00.000Z", text: "我们已经到科技馆了，先看哪个展厅？" },
    { id: "m-a2", role: "assistant", speaker: "Suzu", timestamp: "2026-07-04T08:00:04.000Z", text: "先去航天展厅吧。" },
    { id: "m-u3", role: "user", speaker: "用户", timestamp: "2026-07-05T08:00:00.000Z", text: "你上次主动关心是什么时候？" },
    { id: "m-a3", role: "assistant", speaker: "Suzu", timestamp: "2026-07-05T08:00:04.000Z", text: "是昨天。" },
  ];
  fs.writeFileSync(path.join(directory, "history.jsonl"), `${museumMessages.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(directory, "events.jsonl"), "", "utf8");
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    historyFile: "history.jsonl",
    eventsFile: "events.jsonl",
    embedding: { enabled: false },
    eligibility: { strongBm25Score: 0.1, strongBm25Overlap: 3 },
    recall: { maxMemories: 1, eventFallbackMessages: 3, eventFallbackMaxChars: 900 },
    injection: { heading: "你想起了之前的片段：", guidance: "只作为回忆依据。" },
  }), "utf8");

  assert.equal(classifyRecallIntent("我之前什么时候去科技馆的"), "event");
  const result = await retrieveMemories("我之前什么时候去科技馆的", loadRagConfig(configPath));
  assert.equal(result.eventFallbackUsed, true);
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0].memoryType, "event-evidence");
  assert.match(result.context, /相关历史原话证据/u);
  assert.match(result.context, /用户：/u);
  assert.match(result.context, /Suzu：/u);
  assert.ok((result.fragments[0].text.match(/^\[/gmu) || []).length <= 3);

  const unrelated = await retrieveMemories("记得量子火箭燃料那件事吗", loadRagConfig(configPath));
  assert.equal(unrelated.eventFallbackUsed, false);
  assert.equal(unrelated.context, "");
});
