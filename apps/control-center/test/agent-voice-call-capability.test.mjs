import assert from "node:assert/strict";
import test from "node:test";

import { createAgentVoiceCallCapabilityAdapter } from "../electron/services/agent-voice-call-capability.mjs";

test("the Agent voice call capability keeps dial and hangup inside the trusted contact scope", async () => {
  const calls = [];
  const adapter = createAgentVoiceCallCapabilityAdapter({
    voiceCallService: () => ({
      dialFromAgent: async (value) => {
        calls.push({ type: "dial", value });
        return { status: "ringing", requestId: "request-1" };
      },
      hangupFromAgent: async (value) => {
        calls.push({ type: "hangup", value });
        return { status: "ended", callId: "call-1" };
      },
    }),
  });
  const context = {
    contactId: "contact-suzu",
    projectRoot: "D:/Suzu/contact-suzu",
    sessionId: "session-suzu",
  };

  assert.deepEqual(await adapter({
    action: { action: "dial" },
    capability: { id: "voice-call" },
    context: { ...context, input: { reason: "想听听你的声音" } },
    lifecycle: "invoke",
  }), { status: "ringing", requestId: "request-1" });
  assert.deepEqual(await adapter({
    action: { action: "hangup" },
    capability: { id: "voice-call" },
    context,
    lifecycle: "invoke",
  }), { status: "ended", callId: "call-1" });
  assert.deepEqual(calls, [
    {
      type: "dial",
      value: {
        contactId: "contact-suzu",
        projectRoot: "D:/Suzu/contact-suzu",
        reason: "想听听你的声音",
        sessionId: "session-suzu",
      },
    },
    {
      type: "hangup",
      value: context,
    },
  ]);
  await assert.rejects(
    adapter({ action: { action: "dial" }, context: { contactId: "contact-suzu" }, lifecycle: "invoke" }),
    /当前联系人的有效对话/u,
  );
});
