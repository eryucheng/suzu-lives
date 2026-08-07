import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeVoiceMessage, planVoiceMessage, VoiceMessageError } from "../src/index.mjs";
import { CapabilityExecutionError, consumeCapabilityAuthorization, issueCapabilityAuthorization } from "@suzu-lives/capability-runtime";

function authorization(root, scope) {
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId: "voice-message", action: "deliver-voice", scope, now: () => 1_000 });
  return consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "voice-message", action: "deliver-voice", scope, now: () => 1_001 });
}

test("voice planning creates MP3 locally and leaves delivery to the current conversation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-message-"));
  const plan = planVoiceMessage({ dataRoot: root, text: "你好，这是一段测试语音。" });

  assert.equal(plan.status, "ready-to-generate");
  assert.equal(plan.outputFormat, "mp3");
  assert.equal(plan.willReadSessionTokens, false);
  assert.equal(plan.willSendMessage, false);
  assert.equal(fs.existsSync(plan.audioDirectory), false);
  assert.match(plan.nextRequirement, /conversation-attachment/u);
});

test("generic executor rejects an unconfigured gate before it can invoke a voice action", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-gate-"));
  const scope = { fixture: "gate" };
  await assert.rejects(
    () => executeVoiceMessage({
      gate: { enabled: true, configured: false },
      authorization: {},
      invocation: { scope },
    }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_NOT_CONFIGURED",
  );
});

test("generic executor does not bypass the session-scoped voice delivery command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-session-"));
  const scope = { fixture: "session" };
  await assert.rejects(
    () => executeVoiceMessage({
      gate: { enabled: true, configured: true },
      authorization: authorization(root, scope),
      invocation: { scope },
    }),
    (error) => error instanceof VoiceMessageError && /当前 Suzu 会话/u.test(error.message),
  );
});

test("voice planning bounds text and requires one input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-voice-message-input-"));
  assert.throws(() => planVoiceMessage({ dataRoot: root, text: "x".repeat(301) }), VoiceMessageError);
  assert.throws(() => planVoiceMessage({ dataRoot: root }), VoiceMessageError);
});
