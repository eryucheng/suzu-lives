import assert from "node:assert/strict";
import test from "node:test";

import { applyAgentCoreIntegrityPatches } from "../scripts/agent-core-integrity-patches.mjs";

test("Core bundle patch keeps a real DeepSeek tool identity when a continuation is empty", () => {
  const source = [
    "if (call.id !== undefined) block.callId = call.id",
    "if (call.function?.name !== undefined) block.name = call.function.name",
  ].join("\n");

  const patched = applyAgentCoreIntegrityPatches(
    source,
    "C:/vendor/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js",
  );

  assert.match(patched, /typeof call\.id === "string" && call\.id\.length > 0/u);
  assert.match(patched, /typeof call\.function\?\.name === "string" && call\.function\.name\.length > 0/u);
});

test("Core bundle patch keeps the first non-empty tool id in the generic assembler", () => {
  const patched = applyAgentCoreIntegrityPatches(
    "partial.toolCallId = chunk.id",
    "C:/vendor/node_modules/@deepseek-ai/dsh-llm/lib/index.js",
  );

  assert.equal(
    patched,
    'if (typeof chunk.id === "string" && chunk.id.length > 0) partial.toolCallId = chunk.id;',
  );
});

test("Core bundle patch validates message events before session append", () => {
  const source = [
    "function adoptSessionEvent(event) { return event }",
    "const event = deepFreeze({ type, data })",
    "this.surfaceManager.validateNext(event as SessionEvent)",
  ].join("\n");

  const patched = applyAgentCoreIntegrityPatches(
    source,
    "C:/vendor/node_modules/@deepseek-ai/dsh-session/lib/index.js",
  );

  assert.match(
    patched,
    /adoptSessionEvent\(event as SessionEvent\)\s*this\.surfaceManager\.validateNext\(event as SessionEvent\)/u,
  );
});

test("Core bundle patch fails closed when an upstream integrity seam changes", () => {
  assert.throws(
    () => applyAgentCoreIntegrityPatches(
      "const moved = true",
      "C:/vendor/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js",
    ),
    /Cannot apply Suzu Agent Core DeepSeek tool-call id bundle patch/u,
  );
});
