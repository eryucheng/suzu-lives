import assert from "node:assert/strict";
import test from "node:test";

import { eraseContactAgentConversation } from "../electron/services/agent-contact-cleanup.mjs";

function contact({ id, projectRoot, sessionId }) {
  return { id, projectRoot, sessionId };
}

test("contact deletion retains shared attachments without reading any contact history", async () => {
  const target = contact({
    id: "contact-target",
    projectRoot: "D:\\Contacts\\target",
    sessionId: "target-session",
  });
  const historyCalls = [];
  const purgeCalls = [];
  const stopCalls = [];
  const result = await eraseContactAgentConversation({
    contact: target,
    conversation: {
      agentRuntime: {
        history: async (request) => {
          historyCalls.push(request);
          throw new Error("contact deletion must not read Agent history");
        },
        purgeSession: async (request) => {
          purgeCalls.push(request);
          return { sessionDirectoryRemoved: true };
        },
      },
      chat: { stop: async (request) => { stopCalls.push(request); } },
    },
  });

  assert.deepEqual(result, {
    status: "deleted",
    attachmentCleanup: "retained",
    sessionDirectoryRemoved: true,
  });
  assert.deepEqual(stopCalls, [{ sessionId: target.sessionId, projectRoot: target.projectRoot }]);
  assert.deepEqual(historyCalls, []);
  assert.deepEqual(purgeCalls, [{
    sessionId: target.sessionId,
    cwd: target.projectRoot,
    imageAttachmentIds: [],
    protectedImageAttachmentIds: [],
  }]);
});

test("contact deletion is not blocked by an unavailable history reader", async () => {
  const target = contact({
    id: "contact-unavailable",
    projectRoot: "D:\\Contacts\\unavailable",
    sessionId: "unavailable-session",
  });
  let purged = false;
  const result = await eraseContactAgentConversation({
    contact: target,
    conversation: {
      agentRuntime: {
        history: async () => { throw new Error("Suzu Agent 会话未就绪。 "); },
        purgeSession: async () => {
          purged = true;
          return { sessionDirectoryRemoved: true };
        },
      },
      chat: { stop: async () => undefined },
    },
  });

  assert.equal(result.status, "deleted");
  assert.equal(result.attachmentCleanup, "retained");
  assert.equal(purged, true);
});

test("contact deletion skips contacts without a valid Agent session scope", async () => {
  const result = await eraseContactAgentConversation({
    contact: { id: "contact-without-session", projectRoot: "", sessionId: "" },
    conversation: { agentRuntime: { purgeSession: async () => { throw new Error("must not purge"); } } },
  });

  assert.deepEqual(result, { status: "no-agent-session" });
});
