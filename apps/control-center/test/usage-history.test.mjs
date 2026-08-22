import assert from "node:assert/strict";
import test from "node:test";

import { usageHistoryRows } from "../src/features/usage/usage-history.mjs";

const summary = {
  daily: [
    { date: "2026-06-30", amountCny: 1, requestCount: 1 },
    { date: "2026-07-15", amountCny: 2, requestCount: 2, unknownRequestCount: 1 },
    { date: "2026-08-20", amountCny: 3, requestCount: 3 },
    { date: "2026-08-21", amountCny: 4, requestCount: 4 },
  ],
};

test("daily expense history fills missing recent dates with zero totals", () => {
  const rows = usageHistoryRows(summary, { anchor: "2026-08-21", dailyCount: 4 });

  assert.deepEqual(rows.map((item) => [item.key, item.amountCny, item.requestCount]), [
    ["2026-08-21", 4, 4],
    ["2026-08-20", 3, 3],
    ["2026-08-19", 0, 0],
    ["2026-08-18", 0, 0],
  ]);
});

test("monthly expense history groups daily totals into comparable months", () => {
  const rows = usageHistoryRows(summary, { anchor: "2026-08-21", monthlyCount: 3, period: "monthly" });

  assert.deepEqual(rows.map((item) => [item.key, item.amountCny, item.requestCount, item.unknownRequestCount]), [
    ["2026-08", 7, 7, 0],
    ["2026-07", 2, 2, 1],
    ["2026-06", 1, 1, 0],
  ]);
});
