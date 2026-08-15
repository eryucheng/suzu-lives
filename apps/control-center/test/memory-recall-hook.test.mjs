import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  memoryRecallUserPrompt,
  runMemoryRecallHook,
} from "../electron/hooks/memory-recall.mjs";

async function temporaryDataRoot(settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-memory-hook-"));
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings));
  return root;
}

function hookOptions({ calls, dataRoot } = {}) {
  return {
    createContacts: () => ({ snapshot: async () => ({ contacts: [] }) }),
    createNamedConnections: () => ({ resolve: async () => null }),
    createMemoryRuntime: () => ({
      recallForUserPrompt: async (value) => {
        calls.push({ type: "recall", value });
        return { additionalContext: "<suzu-long-term-memory>旧日片段</suzu-long-term-memory>" };
      },
      clearUserPromptRecall: async (value) => { calls.push({ type: "clear", value }); },
      dispose: () => { calls.push({ type: "dispose" }); },
    }),
    createTurnId: () => "test-turn",
    resolveDataRoot: () => dataRoot,
  };
}

test("memory recall UserPrompt hook attaches recall to the current user input", async () => {
  const dataRoot = await temporaryDataRoot({ memoryRecallEnabled: true });
  const projectRoot = path.join(dataRoot, "contact-project");
  const calls = [];
  const result = await runMemoryRecallHook({
    args: ["memory-recall", "--project-root", projectRoot, "--data-root", dataRoot],
    input: JSON.stringify({ prompt: "你还记得我上周说的展吗？", session_id: "contact-session" }),
    ...hookOptions({ calls, dataRoot }),
  });

  assert.equal(result.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(result.hookSpecificOutput?.additionalContext || "", /旧日片段/u);
  assert.equal(calls[0]?.type, "recall");
  assert.equal(calls[0]?.value?.projectRoot, projectRoot);
  assert.equal(calls[0]?.value?.sessionId, "contact-session");
  assert.equal(calls[0]?.value?.turnId, "hook-test-turn");
  assert.equal(calls[0]?.value?.userText, "你还记得我上周说的展吗？");
  assert.ok(calls[0]?.value?.occurredAt instanceof Date);
  assert.equal(calls.some((call) => call.type === "clear"), false);
  assert.equal(calls.at(-1)?.type, "dispose");
});

test("memory recall Hook clears its head for disabled or non-user prompts", async () => {
  const dataRoot = await temporaryDataRoot({ memoryRecallEnabled: false });
  const projectRoot = path.join(dataRoot, "contact-project");
  const calls = [];
  const options = hookOptions({ calls, dataRoot });
  const disabled = await runMemoryRecallHook({
    args: ["memory-recall", "--project-root", projectRoot, "--data-root", dataRoot],
    input: JSON.stringify({ prompt: "记得我们上次聊什么吗？", session_id: "contact-session" }),
    ...options,
  });
  assert.deepEqual(disabled, {});
  assert.equal(calls[0]?.type, "clear");
  assert.equal(calls.some((call) => call.type === "recall"), false);

  await fs.writeFile(path.join(dataRoot, "settings.json"), JSON.stringify({ memoryRecallEnabled: true }));
  calls.length = 0;
  const scheduled = await runMemoryRecallHook({
    args: ["memory-recall", "--project-root", projectRoot, "--data-root", dataRoot],
    input: JSON.stringify({ prompt: "<suzu-schedule-task>内部任务</suzu-schedule-task>", session_id: "contact-session" }),
    ...hookOptions({ calls, dataRoot }),
  });
  assert.deepEqual(scheduled, {});
  assert.equal(calls[0]?.type, "clear");
  assert.equal(calls.some((call) => call.type === "recall"), false);
});

test("memory recall extracts spoken call text but skips Suzu internal prompts", () => {
  assert.equal(memoryRecallUserPrompt("普通聊天"), "普通聊天");
  assert.equal(memoryRecallUserPrompt("<suzu-merchant-task>内部投递</suzu-merchant-task>"), "");
  assert.equal(memoryRecallUserPrompt("<suzu-voice-call-open>{}</suzu-voice-call-open>"), "");
  assert.equal(memoryRecallUserPrompt([
    "<suzu-voice-call-turn>",
    JSON.stringify({ source: "suzu-live-call", transcript: "你好，能听见我吗？" }),
    "</suzu-voice-call-turn>",
  ].join("\n")), "你好，能听见我吗？");
});
