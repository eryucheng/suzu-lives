import assert from "node:assert/strict";
import test from "node:test";

import { registerConversationCompactorIpc } from "../electron/ipc/conversation-compactor-ipc.mjs";

test("conversation compactor IPC exposes native DSH snapshot, save, and rewind run without accepting caller session paths", async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    snapshot(value) { calls.push(["snapshot", value]); return { status: "ready" }; },
    save(value) { calls.push(["save", value]); return { status: "saved" }; },
    run(value) { calls.push(["run", value]); return { status: "completed" }; },
  };
  registerConversationCompactorIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    compactorService: service,
  });

  const scope = { contactId: "contact-suzu" };
  await handlers.get("conversation-compactor:snapshot")(null, scope);
  await handlers.get("conversation-compactor:save")(null, {
    ...scope,
    prompt: "自定义摘要",
    automatic: { enabled: true, tokenThreshold: 15_000, retainTokens: 5_000 },
  });
  await handlers.get("conversation-compactor:run")(null, {
    ...scope,
    manual: { retainTokens: 4_000 },
  });
  assert.deepEqual(calls, [
    ["snapshot", scope],
    ["save", {
      ...scope,
      prompt: "自定义摘要",
      automatic: { enabled: true, tokenThreshold: 15_000, retainTokens: 5_000 },
    }],
    ["run", { ...scope, manual: { retainTokens: 4_000 } }],
  ]);
  assert.deepEqual([...handlers.keys()], [
    "conversation-compactor:snapshot",
    "conversation-compactor:save",
    "conversation-compactor:run",
  ]);
  assert.throws(
    () => handlers.get("conversation-compactor:run")(null, { ...scope, sessionId: "outside-scope" }),
    /联系人范围/u,
  );
});
