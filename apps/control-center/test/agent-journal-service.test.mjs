import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentJournalService, localJournalDate } from "../electron/services/agent-journal-service.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("Agent journal stores one locally scoped entry per contact and calendar day", async () => {
  const dataRoot = await temporaryDirectory("suzu-agent-journal-service-");
  const contactA = "contact-agent-journal-a";
  const contactB = "contact-agent-journal-b";
  let current = new Date(2026, 7, 18, 0, 2);
  const service = createAgentJournalService({
    contactProjectsService: {
      snapshot: async () => ({ contacts: [{ id: contactA, name: "Suzu" }, { id: contactB, name: "小助理" }] }),
    },
    now: () => current,
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  await service.record({ contactId: contactA, content: "今天一起把日记功能想清楚了。", date: "2026-08-18", sessionId: "session-a" });
  current = new Date(2026, 7, 18, 0, 4);
  await service.record({ contactId: contactA, content: "今天一起把日记功能真正做出来了。", date: "2026-08-18", sessionId: "session-a" });
  await service.record({ contactId: contactB, content: "另一位联系人自己的日记。", date: "2026-08-18", sessionId: "session-b" });

  const first = await service.snapshot({ contactId: contactA });
  assert.equal(first.selectedContact?.name, "Suzu");
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].content, "今天一起把日记功能真正做出来了。");
  assert.equal(first.entries[0].sessionId, "session-a");

  const second = await service.snapshot({ contactId: contactB });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].content, "另一位联系人自己的日记。");

  assert.deepEqual(await service.removeContact({ contactId: contactA }), { removed: true });
  const afterRemoval = await service.snapshot({ contactId: contactA });
  assert.equal(afterRemoval.entries.length, 0);
});

test("Agent journal keeps local calendar dates and rejects invalid ones", () => {
  assert.equal(localJournalDate(new Date(2026, 7, 18, 23, 59)), "2026-08-18");
});

test("a completed journal turn cannot recreate data for a deleted contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-agent-journal-removed-contact-");
  const contactId = "contact-agent-journal-removed";
  let active = true;
  const service = createAgentJournalService({
    contactProjectsService: {
      snapshot: async () => ({ contacts: active ? [{ id: contactId, name: "Suzu" }] : [] }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  active = false;
  const result = await service.record({
    contactId,
    content: "这条已完成的回合不该重建已删除联系人的日记。",
    date: "2026-08-18",
  });

  assert.deepEqual(result, { saved: false, reason: "contact-missing" });
  assert.equal((await service.snapshot()).entries.length, 0);
});
