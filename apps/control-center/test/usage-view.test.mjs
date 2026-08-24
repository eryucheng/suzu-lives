import assert from "node:assert/strict";
import test from "node:test";

import { state as appState } from "../src/core/state.mjs";
import { renderUsage } from "../src/features/usage/index.mjs";

test("费用统计范围默认折叠，按需展开后才查看来源", () => {
  const previous = { data: appState.data, timelineFilter: appState.timelineFilter, timelineQuery: appState.timelineQuery };
  const data = {
    status: "ready",
    summary: { today: { amountCny: 1, requestCount: 1 }, month: { amountCny: 2, requestCount: 2 }, conversations: [] },
    sources: [{ name: "DSH", detail: "本机账单记录", tracked: true, status: "ready" }],
    events: [],
    scannedAt: "2026-08-02T00:00:00.000Z",
    priceCatalog: { models: [] },
  };
  try {
    appState.data = data;
    appState.timelineFilter = "all";
    appState.timelineQuery = "";
    const markup = renderUsage({ state: appState });
    assert.match(markup, /<details class="usage-scope">/u);
    assert.match(markup, /费用统计范围/u);
    assert.doesNotMatch(markup, /<details class="usage-scope" open>/u);
  } finally {
    appState.data = previous.data;
    appState.timelineFilter = previous.timelineFilter;
    appState.timelineQuery = previous.timelineQuery;
  }
});

test("费用流水和会话费用显示 suzu助手及各联系人名称", () => {
  const previous = { data: appState.data, timelineFilter: appState.timelineFilter, timelineQuery: appState.timelineQuery };
  const event = {
    amountCny: 0.01,
    feature: "agent-chat",
    model: "deepseek-v4-flash",
    requestId: "assistant-call",
    source: "Suzu 对话",
    subjectName: "suzu助手",
    timestamp: "2026-08-24T01:00:00.000Z",
    turnPrompt: "检查设置",
    units: { inputUncachedTokens: 10, outputTextTokens: 2 },
  };
  const data = {
    status: "ready",
    summary: {
      today: { amountCny: 0.01, requestCount: 1 },
      month: { amountCny: 0.01, requestCount: 1 },
      conversations: [
        { amountCny: 0.01, firstAt: event.timestamp, prompt: "检查设置", requestCount: 1, subjectName: "suzu助手", tools: [] },
        { amountCny: 0.02, firstAt: event.timestamp, prompt: "聊聊天", requestCount: 2, subjectName: "小林", tools: ["calendar"] },
      ],
    },
    sources: [],
    events: [event],
    scannedAt: "2026-08-24T01:05:00.000Z",
    priceCatalog: { models: [] },
  };
  try {
    appState.data = data;
    appState.timelineFilter = "all";
    appState.timelineQuery = "";
    const markup = renderUsage({ state: appState });
    assert.match(markup, /<th>归属<\/th>/u);
    assert.match(markup, /suzu助手/u);
    assert.match(markup, /小林/u);
    assert.match(markup, /搜索归属、模型、请求 ID、会话内容/u);
  } finally {
    appState.data = previous.data;
    appState.timelineFilter = previous.timelineFilter;
    appState.timelineQuery = previous.timelineQuery;
  }
});
