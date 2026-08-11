import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  endActiveConversationCall,
  registerConversationCallEndHandler,
} from "../src/react/conversation-call-coordinator.mjs";
import {
  callStatusLabel,
  downsamplePcm16,
  inputEnergy,
} from "../src/react/conversation-call-utils.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("React call helpers keep PCM conversion, VAD energy, and status labels stable", () => {
  assert.deepEqual(
    [...downsamplePcm16(new Float32Array([-1, -0.5, 0, 0.5, 1, 2]), 16000)],
    [-32768, -16384, 0, 16384, 32767, 32767],
  );
  assert.deepEqual(
    [...downsamplePcm16(new Float32Array([0, 1, 0, 1]), 32000)],
    [16384, 16384],
  );
  assert.ok(Math.abs(inputEnergy(new Float32Array([0.3, -0.3])) - 0.3) < 0.000001);
  assert.equal(callStatusLabel({ phase: "thinking" }), "正在想怎么回答…");
  assert.equal(callStatusLabel({ label: "自定义状态", phase: "error" }), "自定义状态");
});

test("legacy contact changes can request the React call provider to end safely", async () => {
  let endCount = 0;
  const unregister = registerConversationCallEndHandler(async () => { endCount += 1; });
  try {
    assert.equal(await endActiveConversationCall(), true);
    assert.equal(endCount, 1);
  } finally {
    unregister();
  }
  assert.equal(await endActiveConversationCall(), false);
});

test("voice call UI and lifecycle live in React rather than conversation DOM bindings", () => {
  const appShell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const callProvider = readFileSync(resolve(HERE, "..", "src", "react", "conversation-call.jsx"), "utf8");
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const legacyConversation = readFileSync(resolve(HERE, "..", "src", "features", "conversation", "index.mjs"), "utf8");
  const legacyStyles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");

  assert.match(appShell, /ConversationCallProvider/u);
  assert.match(callProvider, /navigator\.mediaDevices/u);
  assert.match(callProvider, /conversation\?\.call\?\.audio/u);
  assert.match(page, /useConversationCall/u);
  assert.match(page, /ConversationCallBar/u);
  assert.match(page, /conversation-call-bar/u);
  assert.doesNotMatch(page, /ConversationCallDialog/u);
  assert.doesNotMatch(page, /conversation-call-overlay/u);
  assert.doesNotMatch(callProvider, /minimized/u);
  assert.doesNotMatch(legacyStyles, /conversation-call-overlay/u);
  assert.doesNotMatch(legacyStyles, /conversation-call-dialog/u);
  assert.doesNotMatch(legacyConversation, /viewState\.call/u);
  assert.doesNotMatch(legacyConversation, /data-open-conversation-call/u);
});
