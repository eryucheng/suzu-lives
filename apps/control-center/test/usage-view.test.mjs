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
