import assert from "node:assert/strict";
import test from "node:test";

import { formatErrorForDisplay } from "../src/error-detail.mjs";

test("formats nested causes for an IPC-safe user-facing error", () => {
  const cause = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const error = new Error("无法保存消息删除记录。", { cause });

  assert.equal(
    formatErrorForDisplay(error),
    "无法保存消息删除记录。（原因：EACCES: permission denied）",
  );
});

test("redacts credentials while retaining the operational failure detail", () => {
  const error = new Error("fetch failed: Bearer test-token api_key=secret-value sk-abcdefghijk");
  const message = formatErrorForDisplay(error);

  assert.match(message, /fetch failed/u);
  assert.doesNotMatch(message, /test-token|secret-value|sk-abcdefghijk/u);
  assert.match(message, /\[已隐藏\]/u);
});

test("uses a stable fallback when no usable Error message exists", () => {
  assert.equal(
    formatErrorForDisplay({ code: "EPIPE" }, { fallback: "无法完成请求。" }),
    "错误代码：EPIPE",
  );
  assert.equal(formatErrorForDisplay(null, { fallback: "无法完成请求。" }), "无法完成请求。");
});
