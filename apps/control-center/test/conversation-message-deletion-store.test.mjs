import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createConversationMessageDeletionStore } from "../electron/services/conversation-message-deletion-store.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-message-deletion-store-"));
}

test("message deletion state is stored with the contact metadata and leaves Core artifacts unchanged", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contacts", "contact-one");
  const coreArtifact = path.join(root, "agent-runtime", "core", "sessions", "session-one", "session.jsonl.zstd");
  await fs.mkdir(path.dirname(coreArtifact), { recursive: true });
  await fs.writeFile(coreArtifact, "agent-core-session", "utf8");

  const store = createConversationMessageDeletionStore({
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
  assert.deepEqual(await store.list({ projectRoot, sessionId: "session-one" }), {
    entries: [],
    revision: "",
  });

  const added = await store.markDeleted({
    projectRoot,
    sessionId: "session-one",
    eventSeq: 42,
    messageId: "assistant-42",
  });
  assert.equal(added.added, true);
  assert.deepEqual(await store.list({ projectRoot, sessionId: "session-one" }), {
    entries: [{
      eventSeq: 42,
      messageId: "assistant-42",
      deletedAt: "2026-08-23T12:00:00.000Z",
    }],
    revision: "42:2026-08-23T12:00:00.000Z",
  });
  assert.equal((await store.markDeleted({
    projectRoot,
    sessionId: "session-one",
    eventSeq: 42,
    messageId: "assistant-42",
  })).added, false);
  assert.equal(await fs.readFile(coreArtifact, "utf8"), "agent-core-session");
  assert.equal(
    await fs.readFile(path.join(projectRoot, ".suzu-lives", "conversation-deletions.json"), "utf8"),
    `${JSON.stringify({
      version: 1,
      sessionId: "session-one",
      messages: [{
        eventSeq: 42,
        messageId: "assistant-42",
        deletedAt: "2026-08-23T12:00:00.000Z",
      }],
    }, null, 2)}\n`,
  );
});
