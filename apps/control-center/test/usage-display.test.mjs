import assert from "node:assert/strict";
import test from "node:test";

import { usageAmountLabel, usageCostLabel } from "../src/features/usage/usage-display.mjs";

test("usage rows show their recorded billing unit instead of treating every event as tokens", () => {
  assert.equal(usageAmountLabel({ inputAudioSeconds: 1.25 }), "1.25 秒");
  assert.equal(usageAmountLabel({ inputCharacters: 42 }), "42 字符");
  assert.equal(usageAmountLabel({ totalInputTokens: 42, totalTokens: 96 }), "42 输入 Token");
  assert.equal(usageAmountLabel({}), "—");
});

test("usage rows distinguish an unconfigured price from a zero-valued estimate", () => {
  assert.equal(usageCostLabel({ amountCny: null, costStatus: "unknown-price" }), "未配置价格");
  assert.equal(usageCostLabel({ amountCny: 0, costStatus: "estimated" }), "¥0.00000");
});
