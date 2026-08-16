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
    process: { platform: "win32" },
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
  assert.equal(bridge?.windowChrome?.customControls, true);
  assert.equal(typeof bridge?.windowChrome?.state, "function");
  assert.equal(typeof bridge?.windowChrome?.control, "function");
  assert.equal(typeof bridge?.windowChrome?.onState, "function");
  assert.equal(typeof bridge?.memory?.brainGraph, "function");
  assert.equal(typeof bridge?.memory?.reviewOverview, "function");
  assert.equal(typeof bridge?.memory?.reviewProposal, "function");
  assert.equal(typeof bridge?.memory?.resolveReview, "function");
  assert.equal(typeof bridge?.memory?.revokeReviewRelation, "function");
  assert.equal(typeof bridge?.memory?.recoverReviewInputBatch, "function");
  assert.equal(typeof bridge?.memory?.createReviewBackup, "function");
  assert.equal(typeof bridge?.memory?.selectReviewBackup, "function");
  assert.equal(typeof bridge?.memory?.selectImportDatabase, "function");
  assert.equal(typeof bridge?.memory?.inspectReviewBackup, "function");
  assert.equal(typeof bridge?.memory?.inspectImportDatabase, "function");
  assert.equal(typeof bridge?.memory?.restoreReviewBackup, "function");
  assert.equal(typeof bridge?.memory?.importDatabase, "function");
  assert.equal(typeof bridge?.conversation?.stop, "function");
  assert.equal(typeof bridge?.conversation?.steer, "function");
  assert.equal(typeof bridge?.conversation?.call?.start, "function");
  assert.equal(typeof bridge?.conversation?.call?.open, "function");
  assert.equal(typeof bridge?.conversation?.call?.audio, "function");
  assert.equal(typeof bridge?.conversation?.call?.commit, "function");
  assert.equal(typeof bridge?.conversation?.call?.interrupt, "function");
  assert.equal(typeof bridge?.conversation?.call?.stop, "function");
  assert.equal(typeof bridge?.conversation?.renameContact, "function");
  assert.equal(typeof bridge?.conversation?.updateContactPresentation, "function");
  assert.equal(typeof bridge?.conversation?.updateContactApprovalMode, "function");
  assert.equal(typeof bridge?.conversation?.updateContactLongTermMemoryEnabled, "function");
  assert.equal(typeof bridge?.conversation?.removeContact, "function");
  assert.equal(typeof bridge?.conversation?.emojiStickers?.snapshot, "function");
  assert.equal(typeof bridge?.conversation?.emojiStickers?.select, "function");
  assert.equal(typeof bridge?.conversation?.emojiStickers?.add, "function");
  assert.equal(typeof bridge?.conversation?.emojiStickers?.send, "function");
  assert.equal(typeof bridge?.conversationCompactor?.snapshot, "function");
  assert.equal(typeof bridge?.conversationCompactor?.save, "function");
  assert.equal(typeof bridge?.conversationCompactor?.check, "function");
  assert.equal(typeof bridge?.conversationCompactor?.run, "function");
  assert.equal(typeof bridge?.conversationCompactor?.selectImportJsonl, "function");
  assert.equal(typeof bridge?.conversationCompactor?.importJsonl, "function");
  assert.equal(typeof bridge?.capabilities?.companionTargets, "function");
  assert.equal(typeof bridge?.wechat?.begin, "function");
  assert.equal(typeof bridge?.wechat?.saveSettings, "function");
  assert.equal(typeof bridge?.voiceDesign?.saveContactVoice, "function");
  assert.equal(typeof bridge?.externalCapabilities?.importManifest, "function");
  assert.equal(typeof bridge?.externalCapabilities?.setEnabled, "function");
  await bridge.conversation.stop({ sessionId: "session-1" });
  await bridge.conversation.steer({ content: "请改为只读" });
  assert.equal(calls[0].channel, "conversation:stop");
  assert.equal(calls[1].channel, "conversation:steer");
  await bridge.conversation.call.start({ initiator: "agent" });
  await bridge.conversation.call.open({ callId: "call-1" });
  await bridge.conversation.call.commit({ callId: "call-1" });
  await bridge.conversation.call.interrupt({ callId: "call-1" });
  await bridge.conversation.call.stop({ callId: "call-1" });
  bridge.conversation.call.audio({ callId: "call-1", audio: new ArrayBuffer(0) });
  assert.equal(calls[2].channel, "conversation:call-start");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2].args[0])), { initiator: "agent" });
  assert.equal(calls[3].channel, "conversation:call-open");
  assert.equal(calls[4].channel, "conversation:call-commit");
  assert.equal(calls[5].channel, "conversation:call-interrupt");
  assert.equal(calls[6].channel, "conversation:call-stop");
  assert.equal(calls[7].channel, "conversation:call-audio");
  await bridge.wechat.begin({ contactId: "contact-suzu" });
  await bridge.wechat.saveSettings({ enabled: true });
  assert.equal(calls[8].channel, "wechat:begin");
  assert.equal(calls[9].channel, "wechat:save-settings");
  await bridge.externalCapabilities.importManifest();
  await bridge.externalCapabilities.setEnabled("sample.capability", true);
  assert.equal(calls[10].channel, "external-capabilities:import");
  assert.equal(calls[11].channel, "external-capabilities:set-enabled");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[11].args[0])), { id: "sample.capability", enabled: true });
  await bridge.voiceDesign.saveContactVoice({ contactId: "contact-suzu", provider: "qwen", voiceId: "voice-kept" });
  assert.equal(calls[12].channel, "voice-design:save-contact-voice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[12].args[0])), { contactId: "contact-suzu", provider: "qwen", voiceId: "voice-kept" });
  await bridge.capabilities.companionTargets();
  assert.equal(calls[13].channel, "capabilities:companion-targets");
  await bridge.conversation.renameContact({ id: "contact-suzu", name: "新备注" });
  assert.equal(calls.at(-1).channel, "conversation:rename-contact");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), { id: "contact-suzu", name: "新备注" });
  await bridge.conversation.updateContactPresentation({ id: "contact-suzu", pinned: true });
  assert.equal(calls.at(-1).channel, "conversation:update-contact-presentation");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), { id: "contact-suzu", pinned: true });
  await bridge.conversation.updateContactApprovalMode({ id: "contact-suzu", approvalMode: "plan" });
  assert.equal(calls.at(-1).channel, "conversation:update-contact-approval-mode");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), { id: "contact-suzu", approvalMode: "plan" });
  await bridge.conversation.updateContactLongTermMemoryEnabled({ id: "contact-suzu", enabled: false });
  assert.equal(calls.at(-1).channel, "conversation:update-contact-long-term-memory");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), { id: "contact-suzu", enabled: false });
  await bridge.conversation.removeContact({ id: "contact-suzu", confirmed: true });
  assert.equal(calls.at(-1).channel, "conversation:remove-contact");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), { id: "contact-suzu", confirmed: true });
  await bridge.conversation.emojiStickers.snapshot();
  await bridge.conversation.emojiStickers.select();
  await bridge.conversation.emojiStickers.add({ selectionToken: "selected-sticker" });
  await bridge.conversation.emojiStickers.send({ id: "sticker-1" });
  assert.deepEqual(calls.slice(-4).map((call) => call.channel), [
    "conversation:emoji-stickers",
    "conversation:select-emoji-sticker",
    "conversation:add-emoji-sticker",
    "conversation:send-emoji-sticker",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-2).args[0])), { selectionToken: "selected-sticker" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), { id: "sticker-1" });
  await bridge.memory.reviewOverview({ reviewStates: ["pending"] });
  await bridge.memory.reviewProposal("relation", "review-1");
  await bridge.memory.resolveReview("structure", "review-2", "accept", "确认");
  await bridge.memory.revokeReviewRelation("review-3", "撤销");
  await bridge.memory.recoverReviewInputBatch("batch-1", true);
  await bridge.memory.createReviewBackup();
  await bridge.memory.selectReviewBackup();
  await bridge.memory.inspectReviewBackup("C:/tmp/memory-backup.db");
  await bridge.memory.restoreReviewBackup("C:/tmp/memory-backup.db");
  assert.deepEqual(calls.slice(-9).map((call) => call.channel), [
    "memory:review-overview",
    "memory:review-proposal",
    "memory:resolve-review",
    "memory:revoke-review-relation",
    "memory:recover-review-input-batch",
    "memory:create-review-backup",
    "memory:select-review-backup",
    "memory:inspect-review-backup",
    "memory:restore-review-backup",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-6).args[0])), {
    proposalId: "review-3",
    note: "撤销",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-5).args[0])), {
    batchId: "batch-1",
    force: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[0])), {
    sourcePath: "C:/tmp/memory-backup.db",
  });
  await bridge.conversationCompactor.snapshot({ contactId: "contact-suzu" });
  await bridge.conversationCompactor.save({ contactId: "contact-suzu", prompt: "联系人专属提示词" });
  await bridge.conversationCompactor.check({ contactId: "contact-suzu" });
  await bridge.conversationCompactor.run({ contactId: "contact-suzu" });
  await bridge.conversationCompactor.selectImportJsonl();
  await bridge.conversationCompactor.importJsonl({ contactId: "contact-suzu", sourcePath: "C:/tmp/history.jsonl" });
  assert.deepEqual(calls.slice(-6).map((call) => call.channel), [
    "conversation-compactor:snapshot",
    "conversation-compactor:save",
    "conversation-compactor:check",
    "conversation-compactor:run",
    "conversation-compactor:select-import-jsonl",
    "conversation-compactor:import-jsonl",
  ]);
  await bridge.windowChrome.state();
  await bridge.windowChrome.control("toggle-maximize");
  assert.deepEqual(calls.slice(-2).map((call) => call.channel), [
    "window-chrome:state",
    "window-chrome:control",
  ]);
  assert.equal(calls.at(-1).args[0], "toggle-maximize");
  assert.equal(typeof bridge?.settings?.appUpdateStatus, "function");
  assert.equal(typeof bridge?.settings?.checkForUpdate, "function");
  assert.equal(typeof bridge?.settings?.downloadUpdate, "function");
  assert.equal(typeof bridge?.settings?.installUpdate, "function");
  assert.equal(typeof bridge?.settings?.systemStatus, "function");
  await bridge.settings.appUpdateStatus();
  await bridge.settings.checkForUpdate();
  await bridge.settings.downloadUpdate();
  await bridge.settings.installUpdate();
  await bridge.settings.systemStatus();
  assert.deepEqual(calls.slice(-5).map((call) => call.channel), [
    "settings:app-update-status",
    "settings:check-for-update",
    "settings:download-update",
    "settings:install-update",
    "settings:system-status",
  ]);
});
