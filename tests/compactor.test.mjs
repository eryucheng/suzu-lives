import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_OUTPUT_SCHEMA,
  assignMemoryRefs,
  buildLlmInput,
  chooseCompactionPlan,
  isStructuredOutputCompatibilityError,
  isStructuredOutputTurnLimitError,
  parseGeneratedMemoryResult,
  parseJsonlText,
} from "../memory/manual_compactor/compact-jsonl.mjs";

function messageEntry(index, {
  uuid,
  parentUuid = null,
  role,
  text,
  timestamp,
  usage,
  isCompactSummary = false,
}) {
  return {
    index,
    line: index + 1,
    raw: "",
    record: {
      uuid,
      parentUuid,
      timestamp,
      type: role,
      isCompactSummary,
      message: { role, content: text, ...(usage ? { usage } : {}) },
    },
  };
}

test("JSONL 损坏时报告准确行号", () => {
  assert.throws(
    () => parseJsonlText('{"uuid":"ok"}\nnot-json\n', "fixture.jsonl"),
    /fixture\.jsonl:2/u,
  );
});

test("超过处理间隔后保留最近 24 小时完整原文", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const logical = [
    messageEntry(0, { uuid: "u-old", role: "user", text: "三天前的问题", timestamp: "2026-07-13T08:00:00.000Z" }),
    messageEntry(1, { uuid: "a-old", parentUuid: "u-old", role: "assistant", text: "三天前的回复", timestamp: "2026-07-13T08:00:05.000Z" }),
    messageEntry(2, { uuid: "u-new", parentUuid: "a-old", role: "user", text: "昨晚的新话题", timestamp: "2026-07-15T18:00:00.000Z" }),
    messageEntry(3, { uuid: "a-new", parentUuid: "u-new", role: "assistant", text: "昨晚的回复", timestamp: "2026-07-15T18:00:05.000Z", usage: { input_tokens: 8000 } }),
  ];

  const plan = chooseCompactionPlan({ logical, compact: null }, now);
  assert.equal(plan.action, "compact");
  assert.equal(plan.mode, "recent-hours");
  assert.equal(plan.head.record.uuid, "u-new");
  assert.deepEqual(plan.prefix.map((item) => item.record.uuid), ["u-old", "a-old"]);
});

test("24 小时内只在超过 15k tokens 时提前处理", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const summary = messageEntry(0, {
    uuid: "summary",
    role: "user",
    text: "既有记忆",
    timestamp: "2026-07-16T05:00:00.000Z",
    isCompactSummary: true,
  });
  const user = messageEntry(1, { uuid: "u1", parentUuid: "summary", role: "user", text: "新的事情", timestamp: "2026-07-16T06:00:00.000Z" });
  const assistant = messageEntry(2, { uuid: "a1", parentUuid: "u1", role: "assistant", text: "新的回复", timestamp: "2026-07-16T06:00:05.000Z", usage: { input_tokens: 15000 } });
  const boundary = { record: { timestamp: "2026-07-16T05:00:00.000Z" } };
  const compact = { boundary, summary, metadata: {} };

  const skipped = chooseCompactionPlan({ logical: [summary, user, assistant], compact }, now);
  assert.equal(skipped.action, "skip");

  assistant.record.message.usage.input_tokens = 15001;
  const planned = chooseCompactionPlan({ logical: [summary, user, assistant], compact }, now);
  assert.equal(planned.action, "compact");
  assert.equal(planned.mode, "token-tail");
});

test("摘要输入只给归档消息分配短引用，切点参考没有事件引用", () => {
  const archived = assignMemoryRefs([
    { timestamp: "2026-07-13T08:00:00.000Z", role: "user", text: "我们周六去看海。" },
    { timestamp: "2026-07-13T08:00:05.000Z", role: "assistant", text: "我会记得。" },
  ]);
  assert.deepEqual(archived.map((item) => item.memory_ref), ["M0001", "M0002"]);

  const preservedLogical = [
    messageEntry(0, { uuid: "u-new", role: "user", text: "后面的原文", timestamp: "2026-07-15T18:00:00.000Z" }),
  ];
  const input = buildLlmInput(
    { memoryOwner: "Agent", userName: "对方", boundaryContextMessages: 20 },
    { prefix: [], preservedLogical, mode: "recent-hours" },
    archived,
  );
  assert.match(input, /\[M0001\].*我们周六去看海/u);
  assert.match(input, /\[M0002\].*我会记得/u);
  assert.match(input, /切点后的衔接参考/u);
  assert.doesNotMatch(input.match(/【切点后的衔接参考[\s\S]*?【输出要求】/u)?.[0] || "", /\[M\d{4}\]/u);
});

test("一次性 LLM 结果允许完整 JSON 代码围栏并严格校验结构", () => {
  const result = parseGeneratedMemoryResult(`\`\`\`json
{"summary":"我记得我们的约定。","events":[{"title":"周六看海","text":"我们约好周六去看海。","event_date":"2026-07-18","status":"ongoing","source_refs":["M0001"]}]}
\`\`\``);
  assert.equal(result.summary, "我记得我们的约定。");
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].source_refs, ["M0001"]);

  assert.throws(
    () => parseGeneratedMemoryResult('{"summary":"有效摘要","events":[{"title":"事件","text":"内容","event_date":"unknown","status":"ongoing","source_refs":["BAD"]}]}'),
    /M0001/u,
  );
  assert.throws(
    () => parseGeneratedMemoryResult('{"summary":"有效摘要","events":[{"title":"事件","text":"内容","event_date":"2026-02-30","status":"ongoing","source_refs":["M0001"]}]}'),
    /event_date/u,
  );
  assert.throws(
    () => parseGeneratedMemoryResult('{"summary":"有效摘要","events":[],"extra":true}'),
    /只能包含 summary 和 events/u,
  );
});

test("一次性 LLM 结果可以直接接收 --json-schema 返回的对象", () => {
  const result = parseGeneratedMemoryResult({
    summary: "我记得这件事。",
    events: [],
  });
  assert.equal(result.summary, "我记得这件事。");
  assert.deepEqual(result.events, []);
  assert.equal(MEMORY_OUTPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual(MEMORY_OUTPUT_SCHEMA.required, ["summary", "events"]);
});

test("只把结构化输出兼容错误识别为 Schema 回退条件", () => {
  assert.equal(isStructuredOutputCompatibilityError("unknown option '--json-schema'"), true);
  assert.equal(isStructuredOutputCompatibilityError("output_config is not supported by this provider"), true);
  assert.equal(
    isStructuredOutputCompatibilityError("一次性LLM的 result 不是有效JSON：Expected ','"),
    false,
  );
  assert.equal(isStructuredOutputCompatibilityError("401 unauthorized"), false);
});

test("识别 Schema 内部工具提交被 max-turns 截断的错误", () => {
  const actualError = JSON.stringify({
    subtype: "error_max_turns",
    stop_reason: "tool_use",
    terminal_reason: "max_turns",
    errors: ["Reached maximum number of turns (1)"],
  });
  assert.equal(isStructuredOutputTurnLimitError(actualError), true);
  assert.equal(isStructuredOutputTurnLimitError("Reached maximum number of turns (1)"), false);
  assert.equal(isStructuredOutputTurnLimitError('{"stop_reason":"tool_use"}'), false);
});
