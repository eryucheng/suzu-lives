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

test("session notes are local and stay isolated by project root plus Claude session id", async () => {
  const root = await temporaryDirectory("suzu-session-settings-");
  const firstProject = path.join(root, "first-project");
  const secondProject = path.join(root, "second-project");
  let projectRoot = firstProject;
  const service = createConversationSessionSettingsService({
    dataRoot: root,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    reader: {
      resolveSession: async (sessionId) => ({ id: sessionId, projectRoot, hasTranscript: true }),
    },
  });

  const first = await service.save({ sessionId: "same-session-id", note: "第一条会话的备注" });
  assert.equal(first.note, "第一条会话的备注");
  projectRoot = secondProject;
  assert.equal((await service.snapshot({ sessionId: "same-session-id" })).note, "");
  await service.save({ sessionId: "same-session-id", note: "第二条会话的备注" });
  projectRoot = firstProject;
  assert.equal((await service.snapshot({ sessionId: "same-session-id" })).note, "第一条会话的备注");

  const media = await service.mediaDirectory({ sessionId: "same-session-id" });
  assert.equal(media.directory, path.join(root, "agents", stableAgentId(firstProject), "conversations", "same-session-id", "attachments"));
  assert.equal((await fs.stat(media.directory)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(root, "agents", stableAgentId(firstProject), "conversations", "same-session-id", "session.json"))).isFile(), true);
});
