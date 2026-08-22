import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  conversationReactSnapshot,
  createConversationReactActions,
  startConversationPolling,
  stopConversationPolling,
} from "../src/features/conversation/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("联系人主动关心在长期记忆之前，并复用能力配置开关", async () => {
  const [conversationFeature, conversationPage] = await Promise.all([
    source("src", "features", "conversation", "index.mjs"),
    source("src", "react", "conversation-page.jsx"),
  ]);

  assert.match(conversationPage, /<h2>主动关心<\/h2>[\s\S]*?<h2>长期记忆<\/h2>/u);
  assert.match(conversationPage, /checked=\{settings\.proactiveContactEnabled\}/u);
  assert.match(conversationPage, /actions\.setProactiveContactEnabled/u);
  assert.match(conversationFeature, /proactiveContactEnabled: proactiveContactEnabled\(contactId\)/u);
  assert.match(conversationFeature, /api\.capabilities\.snapshot/u);
  assert.match(conversationFeature, /api\.capabilities\.saveSettings\("proactive-contact"/u);
  assert.match(conversationFeature, /setCapabilityPage\?\.\("detail", "companion", "wechat-connection"\)/u);
});

test("联系人设置直接保存主动关心的现有按联系人能力配置", async () => {
  const priorWindow = globalThis.window;
  const saved = [];
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const capabilitySnapshot = (enabledContactIds) => ({
    capabilities: [{
      id: "proactive-contact",
      savedSettings: { enabledContactIds },
    }],
  });
  const context = {
    api: {
      capabilities: {
        saveSettings: async (id, value) => {
          saved.push({ id, value });
          return { ok: true, value: capabilitySnapshot(["contact-suzu"]) };
        },
        snapshot: async () => capabilitySnapshot([]),
      },
      conversation: {
        onEvent: () => () => {},
        snapshot: async () => ({
          activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
          activeSessionId: "session-suzu",
          contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [],
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "proactive-contact-action-test",
        }),
      },
    },
    render: () => {},
    state: { settings: {} },
  };

  try {
    startConversationPolling(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const actions = createConversationReactActions(context);
    await actions.openSessionSettings();
    assert.equal(conversationReactSnapshot(context).sessionSettings?.proactiveContactEnabled, false);

    await actions.setProactiveContactEnabled(true);
    assert.deepEqual(saved, [{
      id: "proactive-contact",
      value: { contactEnabled: true, contactId: "contact-suzu" },
    }]);
    assert.equal(conversationReactSnapshot(context).sessionSettings?.proactiveContactEnabled, true);
    assert.equal(context.state.capabilitySnapshot?.capabilities[0]?.id, "proactive-contact");
    actions.closeSessionSettings();
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
