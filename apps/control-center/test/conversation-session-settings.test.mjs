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

test("contact media stays isolated even when Claude session ids match", async () => {
  const root = await temporaryDirectory("suzu-session-settings-");
  const firstProject = path.join(root, "first-project");
  const secondProject = path.join(root, "second-project");
  const contacts = {
    "contact-first": { id: "same-session-id", projectRoot: firstProject },
    "contact-second": { id: "same-session-id", projectRoot: secondProject },
  };
  const service = createConversationSessionSettingsService({
    dataRoot: root,
    reader: {
      resolveContactSession: async (contactId) => ({
        contactId,
        id: contacts[contactId]?.id || "",
        projectRoot: contacts[contactId]?.projectRoot || "",
        hasTranscript: Boolean(contacts[contactId]),
      }),
    },
  });

  const first = await service.mediaDirectory({ contactId: "contact-first" });
  const second = await service.mediaDirectory({ contactId: "contact-second" });
  assert.equal(first.contactId, "contact-first");
  assert.equal(first.directory, path.join(root, "agents", stableAgentId(firstProject), "conversations", "same-session-id", "attachments"));
  assert.equal(second.directory, path.join(root, "agents", stableAgentId(secondProject), "conversations", "same-session-id", "attachments"));
  assert.equal((await fs.stat(first.directory)).isDirectory(), true);
  assert.equal((await fs.stat(second.directory)).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(root, "agents", stableAgentId(firstProject), "conversations", "same-session-id", "session.json")), { code: "ENOENT" });
});
