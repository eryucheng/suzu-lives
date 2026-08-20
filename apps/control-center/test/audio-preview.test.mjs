import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("voice message settings keep voice management inside the capability page", async () => {
  const detail = await fs.readFile(new URL("../src/react/capability-detail-page.jsx", import.meta.url), "utf8");
  assert.match(detail, /voice-message/u);
  assert.match(detail, /realtime-asr/u);
  assert.match(detail, /新增音色/u);
  assert.match(detail, /deleteCustomVoice/u);
  assert.doesNotMatch(detail, /new Audio\(objectUrl\)/u);
});
