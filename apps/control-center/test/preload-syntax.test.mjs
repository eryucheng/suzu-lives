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
  assert.equal(typeof bridge?.conversation?.sessionSettingsSnapshot, "function");
  assert.equal(typeof bridge?.wechat?.begin, "function");
  assert.equal(typeof bridge?.wechat?.saveSettings, "function");
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
  await bridge.conversation.sessionSettingsSnapshot({ sessionId: "session-1" });
  await bridge.wechat.begin({ sessionId: "session-1" });
  await bridge.wechat.saveSettings({ enabled: true });
  assert.equal(calls[3].channel, "conversation:session-settings-snapshot");
  assert.equal(calls[4].channel, "wechat:begin");
  assert.equal(calls[5].channel, "wechat:save-settings");
  await bridge.externalCapabilities.importManifest();
  await bridge.externalCapabilities.setEnabled("sample.capability", true);
  assert.equal(calls[6].channel, "external-capabilities:import");
  assert.equal(calls[7].channel, "external-capabilities:set-enabled");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[7].args[0])), { id: "sample.capability", enabled: true });
});
