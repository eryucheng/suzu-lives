import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseGeneratedCompaction } from "@suzu-lives/memory-compactor";

function clean(value) {
  return String(value ?? "").trim();
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function nonNegativeInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${field} 必须是非负整数。`);
  return number;
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组。`);
  const result = value.map(clean);
  if (result.some((item) => !item)) throw new Error(`${field} 不能包含空字符串。`);
  return result;
}

function normalizeMessage(value, field, { requireRef }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  const role = clean(value.role);
  const text = clean(value.text);
  const ref = clean(value.ref);
  if (!["user", "assistant"].includes(role)) throw new Error(`${field}.role 无效。`);
  if (!text) throw new Error(`${field}.text 不能为空。`);
  if (requireRef && !/^M\d{4}$/u.test(ref)) throw new Error(`${field}.ref 必须是 M0001 形式。`);
  if (!requireRef && ref) throw new Error(`${field} 不得提供可引用 ref。`);
  return { ref, role, text, timestamp: clean(value.timestamp) };
}

function normalizeActorExpectation(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  const role = clean(value.role);
  const actorRole = clean(value.actorRole);
  if (!role || !actorRole) throw new Error(`${field} 需要 role 和 actorRole。`);
  return { role, actorRole };
}

function normalizeMemoryExpectation(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  const result = {
    kind: clean(value.kind),
    subjectRole: clean(value.subjectRole),
    reality: clean(value.reality),
    temporalState: clean(value.temporalState),
    revisionAction: clean(value.revisionAction),
    retentionReason: clean(value.retentionReason),
    contentIncludes: stringArray(value.contentIncludes, `${field}.contentIncludes`),
    actorRoles: Array.isArray(value.actorRoles)
      ? value.actorRoles.map((item, index) => normalizeActorExpectation(item, `${field}.actorRoles[${index}]`))
      : [],
  };
  if (!Object.values(result).some((item) => Array.isArray(item) ? item.length : Boolean(item))) {
    throw new Error(`${field} 至少需要一个匹配条件。`);
  }
  return result;
}

export function normalizeIngestionEvaluationCase(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`cases[${index}] 必须是对象。`);
  }
  const id = clean(value.id);
  if (!id) throw new Error(`cases[${index}].id 不能为空。`);
  if (!Array.isArray(value.messages) || !value.messages.length) {
    throw new Error(`cases[${index}].messages 不能为空。`);
  }
  const messages = value.messages.map((item, messageIndex) => normalizeMessage(
    item,
    `cases[${index}].messages[${messageIndex}]`,
    { requireRef: true },
  ));
  const refs = messages.map((message) => message.ref);
  if (new Set(refs).size !== refs.length) throw new Error(`cases[${index}] 的消息 ref 重复。`);
  const boundaryMessages = Array.isArray(value.boundaryMessages)
    ? value.boundaryMessages.map((item, messageIndex) => normalizeMessage(
      item,
      `cases[${index}].boundaryMessages[${messageIndex}]`,
      { requireRef: false },
    ))
    : [];
  const expectation = value.expect;
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) {
    throw new Error(`cases[${index}].expect 必须是对象。`);
  }
  const minimumMemories = nonNegativeInteger(
    expectation.minimumMemories,
    `cases[${index}].expect.minimumMemories`,
    0,
  );
  const maximumMemories = nonNegativeInteger(
    expectation.maximumMemories,
    `cases[${index}].expect.maximumMemories`,
    Number.MAX_SAFE_INTEGER,
  );
  if (minimumMemories > maximumMemories) {
    throw new Error(`cases[${index}] 的最小记忆数不能大于最大记忆数。`);
  }
  return {
    id,
    title: clean(value.title) || id,
    category: clean(value.category) || "uncategorized",
    memoryOwner: clean(value.memoryOwner) || "Suzu",
    userName: clean(value.userName) || "用户",
    messages,
    boundaryMessages,
    expect: {
      minimumMemories,
      maximumMemories,
      required: Array.isArray(expectation.required)
        ? expectation.required.map((item, itemIndex) => normalizeMemoryExpectation(
          item,
          `cases[${index}].expect.required[${itemIndex}]`,
        ))
        : [],
      forbidden: Array.isArray(expectation.forbidden)
        ? expectation.forbidden.map((item, itemIndex) => normalizeMemoryExpectation(
          item,
          `cases[${index}].expect.forbidden[${itemIndex}]`,
        ))
        : [],
      summaryIncludes: stringArray(
        expectation.summaryIncludes,
        `cases[${index}].expect.summaryIncludes`,
      ),
    },
  };
}

function isNormalizedIngestionCase(value) {
  return Boolean(
    value
    && Array.isArray(value.messages)
    && Array.isArray(value.boundaryMessages)
    && value.expect
    && Number.isInteger(value.expect.minimumMemories)
    && Number.isInteger(value.expect.maximumMemories)
    && Array.isArray(value.expect.required)
    && Array.isArray(value.expect.forbidden)
    && Array.isArray(value.expect.summaryIncludes),
  );
}

function normalizedIngestionCase(value, index = 0) {
  return isNormalizedIngestionCase(value)
    ? value
    : normalizeIngestionEvaluationCase(value, index);
}

export function loadIngestionEvaluationCases(filePath) {
  const resolved = path.resolve(filePath);
  const document = loadJson(resolved);
  const rawCases = Array.isArray(document) ? document : document?.cases;
  if (!Array.isArray(rawCases)) {
    throw new Error(`${resolved} 必须是案例数组，或包含 cases 数组的对象。`);
  }
  const cases = rawCases.map(normalizeIngestionEvaluationCase);
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`输入评测案例ID重复：${item.id}`);
    ids.add(item.id);
  }
  return {
    sourcePath: resolved,
    version: Number(Array.isArray(document) ? 1 : document.version || 1),
    description: clean(Array.isArray(document) ? "" : document.description),
    cases,
  };
}

function formatMessage(message, includeRef) {
  const speaker = message.role === "assistant" ? "我" : "对方";
  const ref = includeRef ? `[${message.ref}] ` : "";
  return `${ref}[${message.timestamp}] ${speaker}：${message.text}`;
}

export function buildIngestionEvaluationInput(testCase) {
  const item = normalizedIngestionCase(testCase);
  const parts = [
    `记忆拥有者：${item.memoryOwner}`,
    `对方名字：${item.userName}`,
    "本次切分模式：ingestion-evaluation",
    "",
    "【需要归档的真实对话】",
    "",
    item.messages.map((message) => formatMessage(message, true)).join("\n\n"),
  ];
  if (item.boundaryMessages.length) {
    parts.push(
      "",
      "【切点后的衔接参考，不属于归档范围】",
      "只能用于判断切点处的事情是否仍在进行；不得把仅在这里发生的进展或结果提前写入。",
      "",
      item.boundaryMessages.map((message) => formatMessage(message, false)).join("\n\n"),
    );
  }
  return `${parts.join("\n").trim()}\n`;
}

export function createCompactionIngestionExecutor({ generate, systemPrompt }) {
  if (typeof generate !== "function") throw new Error("输入评测需要 generate 函数。");
  if (!clean(systemPrompt)) throw new Error("输入评测需要 systemPrompt。");
  return async (testCase) => {
    const generation = await generate({
      input: buildIngestionEvaluationInput(testCase),
      systemPrompt,
      schemaName: "memory-compaction-v1",
    });
    return generation?.output ?? generation;
  };
}

function matchesExpectation(memory, expectation) {
  for (const field of [
    "kind",
    "subjectRole",
    "reality",
    "temporalState",
    "revisionAction",
    "retentionReason",
  ]) {
    if (expectation[field] && clean(memory[field]) !== expectation[field]) return false;
  }
  const content = clean(memory.content);
  if (!expectation.contentIncludes.every((value) => content.includes(value))) return false;
  return expectation.actorRoles.every((expected) => memory.actorRoles.some((actor) => (
    actor.role === expected.role && actor.actorRole === expected.actorRole
  )));
}

function comparison(rule, passed, expected, actual) {
  return { rule, passed: Boolean(passed), expected, actual };
}

function memoryObservation(memory) {
  const content = clean(memory.content);
  return {
    kind: memory.kind,
    subjectRole: memory.subjectRole,
    reality: memory.reality,
    temporalState: memory.temporalState,
    revisionAction: memory.revisionAction,
    retentionReason: memory.retentionReason,
    eventDate: memory.eventDate,
    eventStart: memory.eventStart,
    eventEnd: memory.eventEnd,
    actorRoles: memory.actorRoles,
    sourceRefs: memory.sourceRefs,
    contentChars: content.length,
    contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

export function evaluateIngestionResult(testCase, output, { includeContent = false } = {}) {
  const item = normalizedIngestionCase(testCase);
  const parsed = parseGeneratedCompaction(output);
  const knownRefs = new Set(item.messages.map((message) => message.ref));
  const usedRefs = parsed.memories.flatMap((memory) => memory.sourceRefs);
  const unknownRefs = [...new Set(usedRefs.filter((ref) => !knownRefs.has(ref)))];
  const assertions = [
    comparison(
      "minimum-memories",
      parsed.memories.length >= item.expect.minimumMemories,
      item.expect.minimumMemories,
      parsed.memories.length,
    ),
    comparison(
      "maximum-memories",
      parsed.memories.length <= item.expect.maximumMemories,
      item.expect.maximumMemories,
      parsed.memories.length,
    ),
    comparison("source-refs-known", unknownRefs.length === 0, [], unknownRefs),
  ];
  item.expect.required.forEach((expectation, index) => {
    const matches = parsed.memories
      .map((memory, memoryIndex) => matchesExpectation(memory, expectation) ? memoryIndex : -1)
      .filter((memoryIndex) => memoryIndex >= 0);
    assertions.push(comparison(`required-memory:${index}`, matches.length > 0, expectation, matches));
  });
  item.expect.forbidden.forEach((expectation, index) => {
    const matches = parsed.memories
      .map((memory, memoryIndex) => matchesExpectation(memory, expectation) ? memoryIndex : -1)
      .filter((memoryIndex) => memoryIndex >= 0);
    assertions.push(comparison(`forbidden-memory:${index}`, matches.length === 0, expectation, matches));
  });
  if (item.expect.summaryIncludes.length) {
    const found = item.expect.summaryIncludes.filter((value) => parsed.summary.includes(value));
    assertions.push(comparison(
      "summary-includes",
      found.length === item.expect.summaryIncludes.length,
      item.expect.summaryIncludes,
      found,
    ));
  }
  const observations = parsed.memories.map((memory) => ({
    ...memoryObservation(memory),
    ...(includeContent ? { content: memory.content } : {}),
  }));
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    actual: {
      memoryCount: parsed.memories.length,
      summaryChars: parsed.summary.length,
      summarySha256: createHash("sha256").update(parsed.summary, "utf8").digest("hex"),
      memories: observations,
      ...(includeContent ? { summary: parsed.summary } : {}),
    },
  };
}

function categorySummary(results) {
  const categories = {};
  for (const result of results) {
    const current = categories[result.category] || { total: 0, passed: 0, failed: 0 };
    current.total += 1;
    if (result.passed) current.passed += 1;
    else current.failed += 1;
    categories[result.category] = current;
  }
  return categories;
}

export async function runMemoryIngestionEvaluation({
  cases,
  execute,
  includeContent = false,
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(cases)) throw new Error("输入评测需要 cases 数组。");
  if (typeof execute !== "function") throw new Error("输入评测需要 execute 函数。");
  const normalized = cases.map((item, index) => normalizedIngestionCase(item, index));
  const startedAt = now().toISOString();
  const results = [];
  for (const item of normalized) {
    const start = Date.now();
    try {
      const output = await execute(item);
      const result = evaluateIngestionResult(item, output, { includeContent });
      result.durationMs = Date.now() - start;
      results.push(result);
    } catch (error) {
      results.push({
        id: item.id,
        title: item.title,
        category: item.category,
        passed: false,
        durationMs: Date.now() - start,
        assertions: [comparison("execution", false, "successful execution", error.message)],
        actual: { error: error.message },
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    schemaVersion: 1,
    evaluationType: "memory-ingestion",
    startedAt,
    completedAt: now().toISOString(),
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? passed / results.length : 1,
      categories: categorySummary(results),
    },
    results,
  };
}
