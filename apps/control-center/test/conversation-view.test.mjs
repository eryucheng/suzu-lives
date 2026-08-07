import assert from "node:assert/strict";
import test from "node:test";

import {
  dismissConversationOverlays,
  filterConversationItems,
  parseSuzuConversationCommand,
  renderConversation,
  renderConversationMessages,
  renderRelationshipOverview,
  shouldSubmitConversationOnEnter,
  shouldShowWechatTimeDivider,
  splitAssistantMessageOnBlankLines,
} from "../src/features/conversation/index.mjs";

const messages = [
  { kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] },
  { kind: "assistant", blocks: [{ kind: "thinking", text: "隐藏思考" }, { kind: "tool_use", text: "隐藏工具" }], usage: { input: 3, cacheCreation: null, cacheRead: null, output: 2, total: 5 } },
  { kind: "system", blocks: [{ kind: "text", text: "隐藏系统" }] },
  { kind: "attachment", blocks: [{ kind: "text", text: "隐藏 Hook" }] },
];

test("relationship overview makes the conversation card the accessible subpage entry", () => {
  const overview = renderRelationshipOverview();
  assert.match(overview, /<button type="button" class="relationship-card relationship-card--conversation" data-open-conversation/);
  assert.match(overview, /aria-label="打开对话：查看并继续当前 Claude 会话"/);
  assert.equal((overview.match(/data-open-conversation/g) || []).length, 1);
  assert.match(overview, /<button type="button" class="relationship-card relationship-card--memory" data-open-memory/);
  assert.equal((overview.match(/data-open-memory/g) || []).length, 1);
  assert.match(overview, /data-open-relationship-settings/);
  assert.equal((overview.match(/data-open-relationship-settings/g) || []).length, 1);
  assert.match(overview, /相处设定/u);
  assert.doesNotMatch(overview, /共同记忆|>打开对话<|secondary-button/);
  const connectedOverview = renderRelationshipOverview({
    state: {
      memoryStatus: {
        status: "ready",
        memories: 12,
        edges: 7,
      },
    },
  });
  assert.match(connectedOverview, /12 个节点 · 7 条关联/u);
  const view = renderConversation({ state: { settings: { conversationPreferences: {} } } });
  assert.match(view, /conversation-workspace/);
  assert.match(view, /conversation-roster/);
  assert.match(view, /data-conversation-new/);
  assert.doesNotMatch(view, /独立 Claude 项目/u);
  assert.equal((view.match(/data-conversation-contact=/g) || []).length, 0);
  assert.doesNotMatch(view, /data-return-relationships/);
  assert.match(view, /class="conversation-peer">未选择联系人<\/h1>/);
  assert.match(view, /data-toggle-conversation-search/);
  assert.match(view, /data-toggle-conversation-menu/);
  assert.doesNotMatch(view, /data-toggle-conversation-settings/);
  assert.match(view, /id="conversationComposer"/);
  assert.match(view, /data-conversation-composer/);
  assert.match(view, /conversation-composer__surface/);
  assert.match(view, /data-toggle-conversation-emoji/);
  assert.match(view, /conversation-send-button/);
  assert.doesNotMatch(view, /仅本地只读|RELATIONSHIPS \/ CONVERSATION/u);
});

test("conversation display preferences filter optional records but keep user text", () => {
  const visible = filterConversationItems(messages, { attachments: false, tools: false, thinking: false, system: false, tokens: false });
  assert.deepEqual(visible, [{ kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] }]);

  const tokensOnly = filterConversationItems(messages, { attachments: false, tools: false, thinking: false, system: false, tokens: true });
  assert.equal(tokensOnly.length, 2);
  assert.equal(tokensOnly[1].blocks.length, 0);

  assert.deepEqual(filterConversationItems(messages), [{ kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] }]);
});

test("agent media remains visible as a chat attachment even when tool details are hidden", () => {
  const markup = renderConversationMessages([{
    kind: "assistant",
    timestamp: "2026-08-04T10:00:00+08:00",
    blocks: [{
      kind: "media",
      mediaKind: "file",
      fileName: "agent-report.txt",
      fileUrl: "file:///C:/temp/agent-report.txt",
      size: 2048,
    }],
  }], { state: { settings: { conversationPreferences: { tools: false } } } });
  assert.match(markup, /conversation-media--file/);
  assert.match(markup, /conversation-message assistant is-media-only/);
  assert.match(markup, /agent-report\.txt/);
  assert.match(markup, /2\.0 KB/);
});

test("image attachments render as fixed previews that can be enlarged", () => {
  const markup = renderConversationMessages([{
    id: "assistant-image",
    lineNumber: 42,
    kind: "assistant",
    timestamp: "2026-08-04T10:00:00+08:00",
    blocks: [{
      kind: "media",
      mediaKind: "image",
      fileName: "agent-image.png",
      fileUrl: "file:///C:/temp/agent-image.png",
      size: 2048,
    }],
  }], { state: { settings: { conversationPreferences: { tools: false } } } });
  assert.match(markup, /conversation-media__preview/);
  assert.match(markup, /data-conversation-media-preview=/);
  assert.match(markup, /data-conversation-media-url="file:\/\/\/C:\/temp\/agent-image\.png"/);
  assert.match(markup, /data-conversation-media-message-id="assistant-image"/);
  assert.match(markup, /data-conversation-media-line-number="42"/);
  assert.match(markup, /data-conversation-message-id="assistant-image"/);
  assert.match(markup, /data-conversation-line-number="42"/);
  assert.match(markup, /agent-image\.png/);
});

test("MP3 attachments render an in-Suzu audio player", () => {
  const markup = renderConversationMessages([{
    kind: "assistant",
    timestamp: "2026-08-05T10:00:00+08:00",
    blocks: [{
      kind: "media",
      mediaKind: "audio",
      fileName: "voice.mp3",
      fileUrl: "file:///C:/temp/voice.mp3",
      size: 2048,
    }],
  }], { state: { settings: { conversationPreferences: { tools: false } } } });
  assert.match(markup, /conversation-media--audio/);
  assert.match(markup, /conversation-media__audio/);
  assert.match(markup, /<audio[^>]+controls/u);
  assert.match(markup, /voice\.mp3/);
});

test("conversation overlays close together when the user clicks away or presses Escape", () => {
  const state = { avatarCrop: { source: "data:image/png;base64,avatar" }, contactCreateOpen: true, emojiOpen: true, mediaPreview: { url: "file:///C:/temp/image.png" }, menuOpen: true, searchOpen: false, settingsOpen: true, wechatQrOpen: true };
  assert.equal(dismissConversationOverlays(state), true);
  assert.deepEqual(state, { avatarCrop: null, contactCreateOpen: false, emojiOpen: false, mediaPreview: null, menuOpen: false, searchOpen: false, settingsOpen: false, wechatQrOpen: false });
  assert.equal(dismissConversationOverlays(state), false);
});

test("Suzu reserves a namespaced stop and steer command without swallowing Claude Code slash commands", () => {
  assert.deepEqual(parseSuzuConversationCommand("普通消息"), { action: "message", content: "普通消息" });
  assert.deepEqual(parseSuzuConversationCommand("/compact"), { action: "message", content: "/compact" });
  assert.deepEqual(parseSuzuConversationCommand("/suzu stop"), { action: "stop" });
  assert.deepEqual(parseSuzuConversationCommand("/suzu steer 请先只读分析"), { action: "steer", content: "请先只读分析" });
  assert.deepEqual(parseSuzuConversationCommand("/new"), {
    action: "notice",
    message: "请使用左侧联系人列表右上角的“＋”新建联系人。",
  });
  assert.deepEqual(parseSuzuConversationCommand("/suzu steer"), {
    action: "notice",
    message: "可用的 Suzu 命令：/suzu stop；/suzu steer 请改为……",
  });
});

test("only an unmodified Enter submits the conversation composer", () => {
  assert.equal(shouldSubmitConversationOnEnter({ key: "Enter" }), true);
  assert.equal(shouldSubmitConversationOnEnter({ key: "Enter", ctrlKey: true }), false);
  assert.equal(shouldSubmitConversationOnEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitConversationOnEnter({ key: "Enter", altKey: true }), false);
  assert.equal(shouldSubmitConversationOnEnter({ key: "Enter", metaKey: true }), false);
  assert.equal(shouldSubmitConversationOnEnter({ key: "a" }), false);
});

test("assistant replies split only on blank lines and keep the live state on the final bubble", () => {
  const reply = {
    id: "reply-1",
    kind: "assistant",
    streaming: true,
    usage: { total: 42 },
    blocks: [{ kind: "text", text: "第一条\n保留这一行\n\n第二条\n\n \n第三条" }],
  };
  const parts = splitAssistantMessageOnBlankLines(reply);

  assert.deepEqual(parts.map((item) => item.blocks[0].text), ["第一条\n保留这一行", "第二条", "第三条"]);
  assert.deepEqual(parts.map((item) => item.streaming), [false, false, true]);
  assert.deepEqual(parts.map((item) => item.usage?.total || 0), [0, 0, 42]);
  assert.deepEqual(parts.map((item) => item.sourceMessageId), ["reply-1", "reply-1", "reply-1"]);
  assert.deepEqual(splitAssistantMessageOnBlankLines({ kind: "user", blocks: reply.blocks }), [{ kind: "user", blocks: reply.blocks }]);
});

test("WeChat time mode groups nearby messages and renders a centered divider", () => {
  const first = "2026-08-04T10:00:00+08:00";
  assert.equal(shouldShowWechatTimeDivider("", first), true);
  assert.equal(shouldShowWechatTimeDivider(first, "2026-08-04T10:04:59+08:00"), false);
  assert.equal(shouldShowWechatTimeDivider(first, "2026-08-04T10:05:00+08:00"), true);

  const markup = renderConversationMessages([
    { kind: "assistant", timestamp: first, blocks: [{ kind: "text", text: "第一段\n\n第二段" }] },
    { kind: "user", timestamp: "2026-08-04T10:04:00+08:00", blocks: [{ kind: "text", text: "收到" }] },
  ], { state: { settings: { conversationPreferences: { timeDisplay: "wechat" } } } });
  assert.equal((markup.match(/conversation-message assistant/g) || []).length, 2);
  assert.equal((markup.match(/conversation-time-divider/g) || []).length, 1);
  assert.doesNotMatch(markup, /conversation-meta/);
});
