import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = resolve(HERE, "..", "electron", "preload.cjs");

test("Electron preload remains syntactically valid", () => {
  execFileSync(process.execPath, ["--check", PRELOAD_PATH], {
    stdio: "pipe",
  });
});

test("Electron preload exposes the memory bridge", async () => {
  const exposures = new Map();
  const calls = [];
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      return { ok: true };
    },
    send: (channel, ...args) => {
      calls.push({ channel, args });
    },
    on: () => {},
    removeListener: () => {},
  };

  vm.runInNewContext(readFileSync(PRELOAD_PATH, "utf8"), {
    require: (name) => {
      if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
      return {
        contextBridge: {
          exposeInMainWorld: (name, value) => exposures.set(name, value),
        },
        ipcRenderer,
      };
    },
  }, { filename: PRELOAD_PATH });

  const bridge = exposures.get("suzuConsole");
  assert.equal(typeof bridge?.memory?.brainGraph, "function");
  assert.equal(typeof bridge?.memory?.resolveStructure, "function");
  assert.equal(typeof bridge?.conversation?.stop, "function");
  assert.equal(typeof bridge?.conversation?.steer, "function");
  assert.equal(typeof bridge?.conversation?.call?.start, "function");
  assert.equal(typeof bridge?.conversation?.call?.audio, "function");
  assert.equal(typeof bridge?.conversation?.call?.commit, "function");
  assert.equal(typeof bridge?.conversation?.call?.interrupt, "function");
  assert.equal(typeof bridge?.conversation?.call?.stop, "function");
  assert.equal(typeof bridge?.conversation?.sessionSettingsSnapshot, "function");
  assert.equal(typeof bridge?.wechat?.begin, "function");
  assert.equal(typeof bridge?.wechat?.saveSettings, "function");
  assert.equal(typeof bridge?.voiceDesign?.saveContactVoice, "function");
  assert.equal(typeof bridge?.externalCapabilities?.importManifest, "function");
  assert.equal(typeof bridge?.externalCapabilities?.setEnabled, "function");
  await bridge.memory.resolveStructure("proposal-1", "accept", "确认");
  assert.equal(calls[0].channel, "memory:resolve-structure");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args[0])), {
    proposalId: "proposal-1",
    action: "accept",
    note: "确认",
  });
  await bridge.conversation.stop({ sessionId: "session-1" });
  await bridge.conversation.steer({ content: "请改为只读" });
  assert.equal(calls[1].channel, "conversation:stop");
  assert.equal(calls[2].channel, "conversation:steer");
  await bridge.conversation.call.start();
  await bridge.conversation.call.commit({ callId: "call-1" });
  await bridge.conversation.call.interrupt({ callId: "call-1" });
  await bridge.conversation.call.stop({ callId: "call-1" });
  bridge.conversation.call.audio({ callId: "call-1", audio: new ArrayBuffer(0) });
  assert.equal(calls[3].channel, "conversation:call-start");
  assert.equal(calls[4].channel, "conversation:call-commit");
  assert.equal(calls[5].channel, "conversation:call-interrupt");
  assert.equal(calls[6].channel, "conversation:call-stop");
  assert.equal(calls[7].channel, "conversation:call-audio");
  await bridge.conversation.sessionSettingsSnapshot({ sessionId: "session-1" });
  await bridge.wechat.begin({ sessionId: "session-1" });
  await bridge.wechat.saveSettings({ enabled: true });
  assert.equal(calls[8].channel, "conversation:session-settings-snapshot");
  assert.equal(calls[9].channel, "wechat:begin");
  assert.equal(calls[10].channel, "wechat:save-settings");
  await bridge.externalCapabilities.importManifest();
  await bridge.externalCapabilities.setEnabled("sample.capability", true);
  assert.equal(calls[11].channel, "external-capabilities:import");
  assert.equal(calls[12].channel, "external-capabilities:set-enabled");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[12].args[0])), { id: "sample.capability", enabled: true });
  await bridge.voiceDesign.saveContactVoice({ contactId: "contact-suzu", provider: "qwen", voiceId: "voice-kept" });
  assert.equal(calls[13].channel, "voice-design:save-contact-voice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[13].args[0])), { contactId: "contact-suzu", provider: "qwen", voiceId: "voice-kept" });
});
