import assert from "node:assert/strict";
import test from "node:test";

import { registerConversationCompactorIpc } from "../electron/ipc/conversation-compactor-ipc.mjs";

test("conversation compactor IPC forwards only the selected contact scope", async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    snapshot(value) { calls.push(["snapshot", value]); return { status: "ready" }; },
    save(value) { calls.push(["save", value]); return { status: "ready" }; },
    check(value) { calls.push(["check", value]); return { status: "ready" }; },
    run(value) { calls.push(["run", value]); return { status: "ready" }; },
  };
  registerConversationCompactorIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    compactorService: service,
  });

  const scope = { contactId: "contact-suzu" };
  await handlers.get("conversation-compactor:snapshot")(null, scope);
  await handlers.get("conversation-compactor:save")(null, { ...scope, prompt: "只用于这位联系人" });
  await handlers.get("conversation-compactor:check")(null, scope);
  await handlers.get("conversation-compactor:run")(null, scope);
  assert.deepEqual(calls, [
    ["snapshot", scope],
    ["save", { ...scope, prompt: "只用于这位联系人" }],
    ["check", scope],
    ["run", scope],
  ]);
});
