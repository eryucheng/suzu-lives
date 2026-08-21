import assert from "node:assert/strict";
import test from "node:test";

import { eraseContactAgentConversation } from "../electron/services/agent-contact-cleanup.mjs";

const TARGET_DIGEST = "a".repeat(64);
const SHARED_DIGEST = "b".repeat(64);

function contact({ id, projectRoot, sessionId }) {
  return { id, projectRoot, sessionId };
}

function historyWithImage(seq, digest) {
  return {
    events: [{ event: { seq, data: { attachmentId: `sha256:${digest}` } } }],
    hasMore: false,
  };
}

test("contact deletion continues for a malformed stored session while retaining uncertain attachments", async () => {
  const target = contact({
    id: "contact-broken",
    projectRoot: "D:\\Contacts\\broken",
    sessionId: "broken-session",
  });
  const other = contact({
    id: "contact-other",
    projectRoot: "D:\\Contacts\\other",
    sessionId: "other-session",
  });
  const historyCalls = [];
  const purgeCalls = [];
  const stopCalls = [];
  const result = await eraseContactAgentConversation({
    contact: target,
    contactProjectsService: { snapshot: async () => ({ contacts: [target, other] }) },
    conversation: {
      agentRuntime: {
        history: async (request) => {
          historyCalls.push(request);
          throw new Error('stored session "broken-session" failed validation: Error: session event at seq 2160 message must have tool source');
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
    attachmentCleanup: "retained-unverified",
    sessionDirectoryRemoved: true,
  });
  assert.deepEqual(stopCalls, [{ sessionId: target.sessionId, projectRoot: target.projectRoot }]);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].sessionId, target.sessionId);
  assert.deepEqual(purgeCalls, [{
    sessionId: target.sessionId,
    cwd: target.projectRoot,
    imageAttachmentIds: [],
    protectedImageAttachmentIds: [],
  }]);
});

test("contact deletion still removes known unshared attachments only after all histories verify", async () => {
  const target = contact({
    id: "contact-target",
    projectRoot: "D:\\Contacts\\target",
    sessionId: "target-session",
  });
  const other = contact({
    id: "contact-other",
    projectRoot: "D:\\Contacts\\other",
    sessionId: "other-session",
  });
  const purgeCalls = [];
  const result = await eraseContactAgentConversation({
    contact: target,
    contactProjectsService: { snapshot: async () => ({ contacts: [target, other] }) },
    conversation: {
      agentRuntime: {
        history: async ({ sessionId }) => sessionId === target.sessionId
          ? historyWithImage(2, TARGET_DIGEST)
          : historyWithImage(7, SHARED_DIGEST),
        purgeSession: async (request) => {
          purgeCalls.push(request);
          return { sessionDirectoryRemoved: true };
        },
      },
      chat: { stop: async () => undefined },
    },
  });

  assert.equal(result.attachmentCleanup, "verified");
  assert.deepEqual(purgeCalls, [{
    sessionId: target.sessionId,
    cwd: target.projectRoot,
    imageAttachmentIds: [`sha256:${TARGET_DIGEST}`],
    protectedImageAttachmentIds: [`sha256:${SHARED_DIGEST}`],
  }]);
});

test("contact deletion does not hide an unrelated history failure", async () => {
  const target = contact({
    id: "contact-unavailable",
    projectRoot: "D:\\Contacts\\unavailable",
    sessionId: "unavailable-session",
  });
  let purged = false;
  await assert.rejects(() => eraseContactAgentConversation({
    contact: target,
    contactProjectsService: { snapshot: async () => ({ contacts: [target] }) },
    conversation: {
      agentRuntime: {
        history: async () => { throw new Error("Suzu Agent 会话未就绪。 "); },
        purgeSession: async () => { purged = true; },
      },
      chat: { stop: async () => undefined },
    },
  }), /会话未就绪/u);
  assert.equal(purged, false);
});
