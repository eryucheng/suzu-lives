import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationMessageRows,
  dismissConversationOverlays,
  filterConversationItems,
  isScheduledAgentReply,
  mergeConversationMessages,
  parseSuzuConversationCommand,
  conversationReactSnapshot,
  shouldSubmitConversationOnEnter,
  shouldShowCenteredTimeDivider,
  splitAssistantMessageOnBlankLines,
} from "../src/features/conversation/index.mjs";

const messages = [
  { kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] },
  { kind: "assistant", blocks: [{ kind: "thinking", text: "隐藏思考" }, { kind: "tool_use", text: "隐藏工具" }], usage: { input: 3, cacheCreation: null, cacheRead: null, output: 2, total: 5 } },
  { kind: "system", blocks: [{ kind: "text", text: "隐藏系统" }] },
  { kind: "attachment", blocks: [{ kind: "text", text: "隐藏 Hook" }] },
];

test("conversation React snapshot keeps the current contact model and message rows", () => {
  const view = conversationReactSnapshot({ state: { settings: { conversationPreferences: {} } } });
  assert.equal(view.peer, "未选择联系人");
  assert.equal(view.contacts.length, 0);
  assert.equal(view.hasContactsRoot, false);
  assert.equal(view.call.available, false);
  assert.equal(view.composer.unavailable, true);
  assert.equal(view.messageRows[0]?.type, "empty");
  assert.deepEqual(view.permissions, []);
  assert.equal(view.search, null);
  assert.equal(view.sessionSettings, null);
  assert.equal(view.overlays.contactCreate, false);
  assert.equal(view.overlays.contactRename, null);
  assert.doesNotMatch(view.messageRows[0]?.text || "", /独立 Claude 项目/u);
  assert.doesNotMatch(view.rosterEmpty, /仅本地只读|RELATIONSHIPS \/ CONVERSATION/u);
});

test("conversation display preferences filter optional records but keep user text", () => {
  const visible = filterConversationItems(messages, { attachments: false, tools: false, thinking: false, system: false, tokens: false });
  assert.deepEqual(visible, [{ kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] }]);

  const tokensOnly = filterConversationItems(messages, { attachments: false, tools: false, thinking: false, system: false, tokens: true });
  assert.equal(tokensOnly.length, 2);
  assert.equal(tokensOnly[1].blocks.length, 0);

  assert.deepEqual(filterConversationItems(messages), [{ kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] }]);
});

test("local chat overlays reconcile across tool-heavy transcripts without hiding a later repeated message", () => {
  const sentAt = "2026-08-14T10:00:00.000Z";
  const repliedAt = "2026-08-14T10:01:00.000Z";
  const source = [
    { id: "stored-user", kind: "user", timestamp: sentAt, blocks: [{ kind: "text", text: "请检查这个文件" }] },
    { id: "stored-reply", kind: "assistant", timestamp: repliedAt, blocks: [{ kind: "text", text: "我先看看。" }] },
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `tool-${index}`,
      kind: "system",
      timestamp: `2026-08-14T10:0${2 + Math.floor(index / 8)}:${String((index % 8) * 7).padStart(2, "0")}.000Z`,
      blocks: [{ kind: "text", text: `工具记录 ${index}` }],
    })),
  ];
  const merged = mergeConversationMessages(source, [{
    id: "pending-user",
    requestId: "turn-1",
    sessionId: "session-1",
    content: "请检查这个文件",
    timestamp: sentAt,
  }], new Map([["turn-1", {
    requestId: "turn-1",
    sessionId: "session-1",
    content: "我先看看。",
    timestamp: repliedAt,
  }]]), "session-1");

  assert.equal(merged.filter((item) => item.kind === "user" && item.blocks[0]?.text === "请检查这个文件").length, 1);
  assert.equal(merged.filter((item) => item.kind === "assistant" && item.blocks[0]?.text === "我先看看。").length, 1);

  const repeated = mergeConversationMessages([
    { id: "old", kind: "user", timestamp: "2026-08-14T09:00:00.000Z", blocks: [{ kind: "text", text: "好" }] },
  ], [{
    id: "new", requestId: "turn-2", sessionId: "session-1", content: "好", timestamp: "2026-08-14T10:00:00.000Z",
  }], new Map(), "session-1");
  assert.equal(repeated.filter((item) => item.kind === "user" && item.blocks[0]?.text === "好").length, 2);

  const visibleReply = mergeConversationMessages([
    { id: "before", kind: "user", timestamp: sentAt, blocks: [{ kind: "text", text: "第一条" }] },
    { id: "after", kind: "user", timestamp: "2026-08-14T10:02:00.000Z", blocks: [{ kind: "text", text: "下一条" }] },
  ], [], new Map([["turn-3", {
    requestId: "turn-3", sessionId: "session-1", content: "拒绝后仍保留的回复", timestamp: repliedAt,
  }]]), "session-1");
  assert.deepEqual(visibleReply.map((item) => item.blocks[0]?.text), ["第一条", "拒绝后仍保留的回复", "下一条"]);
});

test("agent media remains visible as a chat attachment even when tool details are hidden", () => {
  const rows = conversationMessageRows([{
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
  const message = rows.find((row) => row.type === "message");
  const media = message?.blocks[0] || {};
  assert.equal(message?.mediaOnly, true);
  assert.equal(message?.kind, "assistant");
  assert.equal(media.type, "media");
  assert.equal(media.mediaKind, "file");
  assert.equal(media.fileName, "agent-report.txt");
  assert.equal(media.size, "2.0 KB");
});

test("image attachments render as fixed previews that can be enlarged", () => {
  const rows = conversationMessageRows([{
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
  const message = rows.find((row) => row.type === "message");
  const media = message?.blocks[0] || {};
  assert.equal(media.type, "media");
  assert.equal(media.mediaKind, "image");
  assert.equal(media.preview?.url, "file:///C:/temp/agent-image.png");
  assert.equal(media.preview?.messageId, "assistant-image");
  assert.equal(media.preview?.lineNumber, 42);
  assert.equal(message?.sourceMessageId, "assistant-image");
  assert.equal(message?.lineNumber, 42);
  assert.equal(media.fileName, "agent-image.png");
});

test("MP3 messages give the React renderer a design-system voice payload", () => {
  const rows = conversationMessageRows([{
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
  const message = rows.find((row) => row.type === "message");
  assert.equal(message?.mediaOnly, true);
  assert.deepEqual(message?.blocks, [{
    fileName: "voice.mp3",
    fileUrl: "file:///C:/temp/voice.mp3",
    type: "audio",
  }]);
});

test("chat bubbles never append delivery or reply-status labels", () => {
  const rows = conversationMessageRows([
    { kind: "user", accepted: true, timestamp: "2026-08-05T10:00:00+08:00", blocks: [{ kind: "text", text: "收到" }] },
    { kind: "assistant", streaming: true, timestamp: "2026-08-05T10:00:01+08:00", blocks: [{ kind: "text", text: "好的" }] },
  ], { state: { settings: { conversationPreferences: { timeDisplay: "bubble" } } } });
  const renderedText = rows
    .filter((row) => row.type === "message")
    .flatMap((row) => row.blocks)
    .map((block) => block.text || block.detail || "")
    .join("\n");
  assert.doesNotMatch(renderedText, /已发送|正在回复|发送中|排队中|引导已送达/u);
});

test("conversation overlays close together when the user clicks away or presses Escape", () => {
  const state = { avatarCrop: { source: "data:image/png;base64,avatar" }, contactCreateOpen: true, contactContextMenu: { contactId: "contact-test" }, contactRenameOpen: true, emojiOpen: true, mediaPreview: { url: "file:///C:/temp/image.png" }, menuOpen: true, searchOpen: false, sessionNoteOpen: true, settingsOpen: true, wechatQrOpen: true };
  assert.equal(dismissConversationOverlays(state), true);
  assert.deepEqual(state, { avatarCrop: null, contactCreateOpen: false, contactContextMenu: null, contactRenameOpen: false, emojiOpen: false, mediaPreview: null, menuOpen: false, searchOpen: false, sessionNoteOpen: false, settingsOpen: false, wechatQrOpen: false });
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

test("only completed scheduled agent text replies are eligible for an outside-chat notification", () => {
  assert.equal(isScheduledAgentReply({ kind: "schedule", type: "agent-reply", content: "你那边现在怎么样？" }), true);
  assert.equal(isScheduledAgentReply({ kind: "schedule", type: "agent-reply", content: "  " }), false);
  assert.equal(isScheduledAgentReply({ kind: "schedule", type: "reply", content: "完成" }), false);
  assert.equal(isScheduledAgentReply({ kind: "message", type: "agent-reply", content: "普通聊天" }), false);
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

test("center time mode groups nearby messages and renders a centered divider", () => {
  const first = "2026-08-04T10:00:00+08:00";
  assert.equal(shouldShowCenteredTimeDivider("", first), true);
  assert.equal(shouldShowCenteredTimeDivider(first, "2026-08-04T10:04:59+08:00"), false);
  assert.equal(shouldShowCenteredTimeDivider(first, "2026-08-04T10:05:00+08:00"), true);

  const rows = conversationMessageRows([
    { kind: "assistant", timestamp: first, blocks: [{ kind: "text", text: "第一段\n\n第二段" }] },
    { kind: "user", timestamp: "2026-08-04T10:04:00+08:00", blocks: [{ kind: "text", text: "收到" }] },
  ], { state: { settings: { conversationPreferences: { timeDisplay: "center" } } } });
  assert.equal(rows.filter((row) => row.type === "message" && row.kind === "assistant").length, 2);
  assert.equal(rows.filter((row) => row.type === "time").length, 1);
  assert.equal(rows.filter((row) => row.type === "message").every((row) => !row.timestamp), true);
});
