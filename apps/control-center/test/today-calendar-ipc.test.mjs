import assert from "node:assert/strict";
import test from "node:test";

import { registerTodayCalendarIpc } from "../electron/ipc/today-calendar-ipc.mjs";

test("today calendar IPC exposes only its snapshot and private-event operations", async () => {
  const handlers = new Map();
  const calls = [];
  registerTodayCalendarIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    todayCalendarService: {
      snapshot: async () => ({ status: "ready" }),
      saveEvent: async (value) => { calls.push(["save", value]); return { status: "ready" }; },
      removeEvent: async (id) => { calls.push(["remove", id]); return { status: "ready" }; },
    },
  });
  assert.deepEqual(await handlers.get("today-calendar:snapshot")(), { status: "ready" });
  await handlers.get("today-calendar:save-event")(null, { name: "纪念日" });
  await handlers.get("today-calendar:remove-event")(null, "event-1");
  assert.deepEqual(calls, [["save", { name: "纪念日" }], ["remove", "event-1"]]);
});
