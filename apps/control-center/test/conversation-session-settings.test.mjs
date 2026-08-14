import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableAgentId } from "@suzu-lives/agent-registry";
import { createConversationSessionSettingsService } from "../electron/services/conversation-session-settings.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("contact notes are local and stay isolated even when Claude session ids match", async () => {
  const root = await temporaryDirectory("suzu-session-settings-");
  const firstProject = path.join(root, "first-project");
  const secondProject = path.join(root, "second-project");
  const contacts = {
    "contact-first": { id: "same-session-id", projectRoot: firstProject },
    "contact-second": { id: "same-session-id", projectRoot: secondProject },
  };
  const service = createConversationSessionSettingsService({
    dataRoot: root,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    reader: {
      resolveContactSession: async (contactId) => ({
        contactId,
        id: contacts[contactId]?.id || "",
        projectRoot: contacts[contactId]?.projectRoot || "",
        hasTranscript: Boolean(contacts[contactId]),
      }),
    },
  });

  const first = await service.save({ contactId: "contact-first", note: "第一条联系人的备注" });
  assert.equal(first.note, "第一条联系人的备注");
  assert.equal((await service.snapshot({ contactId: "contact-second" })).note, "");
  await service.save({ contactId: "contact-second", note: "第二条联系人的备注" });
  assert.equal((await service.snapshot({ contactId: "contact-first" })).note, "第一条联系人的备注");

  const media = await service.mediaDirectory({ contactId: "contact-first" });
  assert.equal(media.contactId, "contact-first");
  assert.equal(media.directory, path.join(root, "agents", stableAgentId(firstProject), "conversations", "same-session-id", "attachments"));
  assert.equal((await fs.stat(media.directory)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(root, "agents", stableAgentId(firstProject), "conversations", "same-session-id", "session.json"))).isFile(), true);
});
