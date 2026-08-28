import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPLETED_REPLY_BUBBLE_INTERVAL_MS,
  companionPeerLabel,
  conversationMessageBlocks,
  conversationMessageRows,
  dismissConversationOverlays,
  filterConversationItems,
  groupConversationToolActivityRows,
  hasMarkdownFormatting,
  isScheduledAgentReply,
  liveReplyPresentationChanged,
  filterDeletedConversationMessages,
  mergeConversationMessageWindow,
  mergeConversationMessages,
  parseSuzuConversationCommand,
  projectedLiveReply,
  createConversationReactActions,
  conversationReactSnapshot,
  startConversationPolling,
  stopConversationPolling,
  shouldSubmitConversationOnEnter,
  shouldShowCenteredTimeDivider,
  splitAssistantMessageOnBlankLines,
  splitCompanionReplyBuffer,
} from "../src/features/conversation/index.mjs";
import { latestConversationMessageSummary } from "../shared/conversation-reply-segmentation.mjs";

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("conversation history keeps a bounded window as older pages are reached", () => {
  const record = (lineNumber) => ({
    id: `message-${lineNumber}`,
    kind: "assistant",
    lineNumber,
    blocks: [{ kind: "text", text: `第 ${lineNumber} 条` }],
  });
  const current = [record(4), record(5), record(6)];
  const older = [record(1), record(2), record(3)];

  const latest = mergeConversationMessageWindow(current, older, { limit: 4 });
  assert.deepEqual(latest.messages.map((message) => message.lineNumber), [3, 4, 5, 6]);
  assert.equal(latest.droppedNewest, false);

  const historical = mergeConversationMessageWindow(current, older, { direction: "older", limit: 4 });
  assert.deepEqual(historical.messages.map((message) => message.lineNumber), [1, 2, 3, 4]);
  assert.equal(historical.droppedNewest, true);

  const retained = mergeConversationMessageWindow(historical.messages, [record(7)], { direction: "retain", limit: 4 });
  assert.deepEqual(retained.messages.map((message) => message.lineNumber), [1, 2, 3, 4]);

  const partialSnapshot = mergeConversationMessageWindow(current, [{
    id: "dynamic-7",
    kind: "dynamic-context",
    lineNumber: 7,
    blocks: [{ kind: "text", text: "本轮上下文" }],
  }], { limit: 4 });
  assert.deepEqual(partialSnapshot.messages.map((message) => message.lineNumber), [4, 5, 6, 7]);
});

test("renderer keeps a deleted historical dynamic context out of the visible projection", () => {
  const visible = filterDeletedConversationMessages([
    {
      id: "dynamic-88",
      kind: "dynamic-context",
      lineNumber: 88,
      blocks: [{ kind: "text", text: "本轮动态上下文" }],
    },
    {
      id: "assistant-89",
      kind: "assistant",
      lineNumber: 89,
      blocks: [{ kind: "text", text: "仍应保留的回复" }],
    },
    {
      id: "live-system",
      kind: "system",
      blocks: [{ kind: "text", text: "本地状态" }],
    },
  ], [88]);

  assert.deepEqual(visible.map((item) => item.id), ["assistant-89", "live-system"]);
});

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
  assert.doesNotMatch(view.messageRows[0]?.text || "", /独立外部项目/u);
  assert.doesNotMatch(view.rosterEmpty, /仅本地只读|RELATIONSHIPS \/ CONVERSATION/u);
});

test("conversation display preferences filter optional records but keep user text", () => {
  const visible = filterConversationItems(messages, { attachments: false, tools: false, thinking: false, system: false, tokens: false });
  assert.deepEqual(visible, [{ kind: "user", blocks: [{ kind: "text", text: "保留的普通文本" }] }]);

  const tokensOnly = filterConversationItems(messages, { attachments: false, tools: false, thinking: false, system: false, tokens: true });
  assert.equal(tokensOnly.length, 2);
  assert.equal(tokensOnly[1].blocks.length, 0);

  const defaults = filterConversationItems(messages);
  assert.equal(defaults.length, 2);
  assert.deepEqual(defaults[1]?.blocks, [{ kind: "tool_use", text: "隐藏工具" }]);
});

test("tool-planning thinking follows the thinking preference and uses the detail renderer", () => {
  const toolPlanning = [{
    kind: "assistant",
    blocks: [{ kind: "thinking", preview: "先核对当前状态。", text: "先核对当前状态。" }],
  }];

  const hidden = conversationMessageRows(toolPlanning, { state: { settings: { conversationPreferences: { thinking: false } } } });
  assert.equal(hidden.some((row) => row.type === "message"), false);
  const shown = conversationMessageRows(toolPlanning, { state: { settings: { conversationPreferences: { thinking: true } } } });
  assert.deepEqual(shown[0]?.blocks, [{ detail: "先核对当前状态。", title: "思考 · 先核对当前状态。", type: "detail" }]);
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

  const assistantBeforeDurableInput = mergeConversationMessages([
    { id: "old-question", kind: "user", timestamp: "2026-08-14T09:58:00.000Z", blocks: [{ kind: "text", text: "上一个问题" }] },
    { id: "stored-agent-step", kind: "assistant", timestamp: "2026-08-14T10:00:01.000Z", blocks: [{ kind: "text", text: "我先检查当前设置。" }] },
  ], [{
    id: "pending-current-question",
    requestId: "turn-pending-order",
    sessionId: "session-1",
    content: "帮我配置识图",
    timestamp: "2026-08-14T10:00:00.000Z",
  }], new Map(), "session-1");
  assert.deepEqual(
    assistantBeforeDurableInput.map((item) => item.blocks[0]?.text),
    ["上一个问题", "帮我配置识图", "我先检查当前设置。"],
  );

  const durableInputAfterAgentStep = mergeConversationMessages([
    { id: "old-question", kind: "user", timestamp: "2026-08-14T09:58:00.000Z", blocks: [{ kind: "text", text: "上一个问题" }] },
    { id: "stored-agent-step", kind: "assistant", timestamp: "2026-08-14T10:00:01.000Z", blocks: [{ kind: "text", text: "我先检查当前设置。" }] },
    { id: "stored-current-question", kind: "user", timestamp: "2026-08-14T10:00:02.000Z", blocks: [{ kind: "text", text: "帮我配置识图" }] },
  ], [{
    id: "pending-current-question",
    requestId: "turn-durable-order",
    sessionId: "session-1",
    content: "帮我配置识图",
    timestamp: "2026-08-14T10:00:00.000Z",
  }], new Map(), "session-1");
  assert.deepEqual(
    durableInputAfterAgentStep.map((item) => item.blocks[0]?.text),
    ["上一个问题", "帮我配置识图", "我先检查当前设置。"],
  );

  const visibleReply = mergeConversationMessages([
    { id: "before", kind: "user", timestamp: sentAt, blocks: [{ kind: "text", text: "第一条" }] },
    { id: "after", kind: "user", timestamp: "2026-08-14T10:02:00.000Z", blocks: [{ kind: "text", text: "下一条" }] },
  ], [], new Map([["turn-3", {
    requestId: "turn-3", sessionId: "session-1", content: "拒绝后仍保留的回复", timestamp: repliedAt,
  }]]), "session-1");
  assert.deepEqual(visibleReply.map((item) => item.blocks[0]?.text), ["第一条", "拒绝后仍保留的回复", "下一条"]);

  const callSequence = mergeConversationMessages([
    { id: "before-call", kind: "user", timestamp: "2026-08-14T10:00:00.000Z", blocks: [{ kind: "text", text: "给我打电话" }] },
    { id: "call-request", kind: "assistant", timestamp: "2026-08-14T10:01:00.000Z", blocks: [{ kind: "text", text: "我现在打给你。" }] },
    { id: "call-answer", kind: "system", timestamp: "2026-08-14T10:00:30.000Z", blocks: [{ kind: "text", text: "通话 · 对方：喂，我在。" }] },
  ], [], new Map(), "session-1");
  assert.deepEqual(callSequence.map((item) => item.blocks[0]?.text), ["给我打电话", "我现在打给你。", "通话 · 对方：喂，我在。"]);
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

test("the shared conversation block adapter renders native tool calls and results", () => {
  const blocks = conversationMessageBlocks({
    kind: "assistant",
    blocks: [
      { kind: "tool_use", name: "pwsh", summary: "{\"command\":\"Get-ChildItem\"}", detail: "{\"command\":\"Get-ChildItem\"}" },
      { kind: "tool_result", error: false, summary: "已读取联系人目录", detail: "已读取联系人目录" },
    ],
  });

  assert.deepEqual(blocks, [
    { detail: "{\"command\":\"Get-ChildItem\"}", detailKind: "tool_use", title: "工具调用 · pwsh · {\"command\":\"Get-ChildItem\"}", type: "detail" },
    { detail: "已读取联系人目录", detailKind: "tool_result", title: "工具结果 · 已读取联系人目录", type: "detail" },
  ]);
});

test("adjacent tool-only messages collapse into one activity group without crossing a reply", () => {
  const rows = conversationMessageRows([
    { id: "tool-start", kind: "assistant", timestamp: "2026-08-25T10:00:00.000Z", blocks: [{ kind: "tool_use", name: "shell", detail: "git status" }] },
    { id: "tool-result", kind: "assistant", timestamp: "2026-08-25T10:00:01.000Z", blocks: [{ kind: "tool_result", detail: "工作区干净" }] },
    { id: "reply", kind: "assistant", timestamp: "2026-08-25T10:00:02.000Z", blocks: [{ kind: "text", text: "我检查好了。" }] },
    { id: "tool-next", kind: "assistant", timestamp: "2026-08-25T10:00:03.000Z", blocks: [{ kind: "tool_use", name: "mail", detail: "发送邮件" }] },
  ], { state: { settings: { conversationPreferences: {} } } });

  const grouped = groupConversationToolActivityRows(rows).filter((row) => row.type !== "time");
  assert.deepEqual(grouped.map((row) => row.type), ["tool-group", "message", "tool-group"]);
  assert.deepEqual(grouped[0]?.entries.map((entry) => entry.detailKind), ["tool_use", "tool_result"]);
  assert.equal(grouped[0]?.entries[0]?.detail, "git status");
  assert.equal(grouped[2]?.entries.length, 1);
});

test("new system and tool records retain the chat-bubble entrance marker", () => {
  const rows = conversationMessageRows([
    {
      animateIn: true,
      id: "call-status",
      kind: "system",
      timestamp: "2026-08-15T10:03:00.000Z",
      blocks: [{ kind: "text", text: "通话系统：正在连接。" }],
    },
    {
      animateIn: true,
      id: "tool-status",
      kind: "assistant",
      timestamp: "2026-08-15T10:03:01.000Z",
      blocks: [{ kind: "tool_use", name: "读取文件", summary: "正在读取", detail: "正在读取文件。" }],
    },
  ], { state: { settings: { conversationPreferences: { system: true, thinking: true } } } });

  assert.equal(rows.filter((row) => row.type === "message").every((row) => row.entering), true);
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

test("companion reply projection hides unfinished token text and only adds completed sentences", () => {
  assert.deepEqual(splitCompanionReplyBuffer("第一句。第二句！第三句？还没说完"), {
    remainder: "还没说完",
    sentences: ["第一句。", "第二句！", "第三句？"],
  });
  assert.deepEqual(splitCompanionReplyBuffer("第一句。第二句", { final: true }), {
    remainder: "",
    sentences: ["第一句。", "第二句"],
  });

  const merged = mergeConversationMessages([{
    id: "user-1",
    kind: "user",
    timestamp: "2026-08-15T10:00:00.000Z",
    blocks: [{ kind: "text", text: "你好" }],
  }], [], new Map([["turn-1", {
    content: "第一句。第二句还没说完",
    phase: "delivering",
    requestId: "turn-1",
    sentences: ["第一句。"],
    sessionId: "session-1",
    timestamp: "2026-08-15T10:00:01.000Z",
  }]]), "session-1");

  assert.deepEqual(merged.map((item) => item.blocks[0]?.text), ["你好", "第一句。"]);
  assert.equal(merged[1]?.streaming, false);
  assert.equal(merged[1]?.animateIn, true);

  const rows = conversationMessageRows(merged, { state: { settings: { conversationPreferences: {} } } });
  assert.equal(rows.find((row) => row.type === "message" && row.blocks[0]?.text === "第一句。")?.entering, true);

  const unfinished = mergeConversationMessages([{
    id: "user-2",
    kind: "user",
    timestamp: "2026-08-15T10:02:00.000Z",
    blocks: [{ kind: "text", text: "继续" }],
  }], [], new Map([["turn-2", {
    content: "还没说完",
    phase: "thinking",
    requestId: "turn-2",
    sentences: [],
    sessionId: "session-1",
    timestamp: "2026-08-15T10:02:01.000Z",
  }]]), "session-1");
  assert.deepEqual(unfinished.map((item) => item.blocks[0]?.text), ["继续"]);
});

test("live text and tool cards follow one Agent Core event timeline", () => {
  const firstReply = projectedLiveReply(null, {
    content: "我先查一下。",
    coreSequence: 21,
    presentationOrder: 1,
    requestId: "turn-ordered",
    sessionId: "session-1",
    timestamp: "2026-08-25T10:00:01.000Z",
  });
  const secondReply = projectedLiveReply(firstReply, {
    content: "我先查一下。查完了。",
    coreSequence: 24,
    presentationOrder: 4,
    requestId: "turn-ordered",
    sessionId: "session-1",
    timestamp: "2026-08-25T10:00:04.000Z",
  });
  assert.deepEqual(secondReply.sentenceTimeline.map((item) => item.coreSequence), [21, 24]);

  const merged = mergeConversationMessages([
    {
      id: "user",
      kind: "user",
      lineNumber: 20,
      timestamp: "2026-08-25T10:00:00.000Z",
      blocks: [{ kind: "text", text: "帮我查一下" }],
    },
    {
      id: "durable-later",
      kind: "assistant",
      lineNumber: 25,
      timestamp: "2026-08-25T10:00:05.000Z",
      blocks: [{ kind: "text", text: "持久记录已经落盘。" }],
    },
  ], [], new Map([["turn-ordered", secondReply]]), "session-1", [], [
    {
      id: "tool-start",
      kind: "assistant",
      sessionId: "session-1",
      requestId: "turn-ordered",
      coreSequence: 22,
      presentationOrder: 2,
      timestamp: "2026-08-25T10:00:02.000Z",
      blocks: [{ kind: "tool_use", summary: "工具调用：weather" }],
    },
    {
      id: "tool-result",
      kind: "assistant",
      sessionId: "session-1",
      requestId: "turn-ordered",
      coreSequence: 23,
      presentationOrder: 3,
      timestamp: "2026-08-25T10:00:03.000Z",
      blocks: [{ kind: "tool_result", summary: "工具结果：weather" }],
    },
  ]);

  assert.deepEqual(
    merged.map((item) => item.blocks[0]?.text || item.blocks[0]?.summary),
    ["帮我查一下", "我先查一下。", "工具调用：weather", "工具结果：weather", "查完了。", "持久记录已经落盘。"],
  );
});

test("multi-step completion keeps the streamed bubbles instead of projecting one aggregate duplicate", () => {
  const first = projectedLiveReply(null, {
    content: "我先检查。",
    requestId: "turn-multi-step",
    sessionId: "session-1",
  });
  const second = projectedLiveReply(first, {
    content: "我先检查。检查完成。",
    requestId: "turn-multi-step",
    sessionId: "session-1",
  });
  const completed = projectedLiveReply(second, {
    assistantMessageCount: 3,
    content: "我先检查。检查完成。\n\n结果如下：\n\n- 文件已保存",
    requestId: "turn-multi-step",
    sessionId: "session-1",
  }, { final: true });

  assert.equal(completed.content, second.content);
  assert.deepEqual(completed.sentences, second.sentences);
  assert.equal(completed.done, true);
  assert.equal(completed.phase, "idle");
});

test("live replies only refresh the conversation when their visible presentation changes", () => {
  const thinking = {
    content: "",
    done: false,
    phase: "thinking",
    remainder: "",
    sentences: [],
  };
  const hiddenTokens = { ...thinking, content: "还没说完", remainder: "还没说完" };
  const firstSentence = {
    ...hiddenTokens,
    content: "第一句。第二句还没说完",
    phase: "delivering",
    remainder: "第二句还没说完",
    sentences: ["第一句。"],
  };

  assert.equal(liveReplyPresentationChanged(thinking, hiddenTokens), false);
  assert.equal(liveReplyPresentationChanged(hiddenTokens, firstSentence), true);
  assert.equal(liveReplyPresentationChanged(firstSentence, { ...firstSentence, content: "第一句。第二句仍未说完", remainder: "第二句仍未说完" }), false);
  assert.equal(liveReplyPresentationChanged(firstSentence, { ...firstSentence, done: true, phase: "idle" }), true);
});

test("companion header substitutes the contact note only during a real thinking phase", () => {
  const replies = new Map([["turn-1", {
    done: false,
    phase: "thinking",
    sessionId: "session-1",
  }]]);
  assert.equal(companionPeerLabel("Suzu", "session-1", replies), "对方正在输入中...");

  replies.set("turn-1", { done: false, phase: "delivering", sessionId: "session-1" });
  assert.equal(companionPeerLabel("Suzu", "session-1", replies), "Suzu");
  assert.equal(companionPeerLabel("Suzu", "other-session", replies), "Suzu");
});

test("conversation overlays close together when the user clicks away or presses Escape", () => {
  const state = { avatarCrop: { source: "data:image/png;base64,avatar" }, confirmation: { title: "请确认" }, contactCreateOpen: true, contactContextMenu: { contactId: "contact-test" }, contactRenameOpen: true, emojiOpen: true, fileContextMenu: { fileUrl: "file:///C:/temp/report.txt" }, mediaPreview: { url: "file:///C:/temp/image.png" }, menuOpen: true, messageContextMenu: { lineNumber: 42 }, qqBindingOpen: true, searchOpen: false, settingsOpen: true, wechatQrOpen: true };
  assert.equal(dismissConversationOverlays(state), true);
  assert.deepEqual(state, { avatarCrop: null, confirmation: null, contactCreateOpen: false, contactContextMenu: null, contactRenameOpen: false, emojiOpen: false, fileContextMenu: null, mediaPreview: null, menuOpen: false, messageContextMenu: null, qqBindingOpen: false, searchOpen: false, settingsOpen: false, wechatQrOpen: false });
  assert.equal(dismissConversationOverlays(state), false);
});

test("Suzu exposes stop and queue while retaining compatible steer parsing without swallowing ordinary slash commands", () => {
  assert.deepEqual(parseSuzuConversationCommand("普通消息"), { action: "message", content: "普通消息" });
  assert.deepEqual(parseSuzuConversationCommand("/compact"), { action: "message", content: "/compact" });
  assert.deepEqual(parseSuzuConversationCommand("/suzu stop"), { action: "stop" });
  assert.deepEqual(parseSuzuConversationCommand("/suzu steer 请先只读分析"), { action: "steer", content: "请先只读分析" });
  assert.deepEqual(parseSuzuConversationCommand("/suzu queue 排队这条"), { action: "queue", content: "排队这条" });
  assert.deepEqual(parseSuzuConversationCommand("/new"), {
    action: "notice",
    message: "请使用左侧联系人列表右上角的“＋”新建联系人。",
  });
  assert.deepEqual(parseSuzuConversationCommand("/suzu steer"), {
    action: "notice",
    message: "可用的 Suzu 命令：/suzu stop 停止；/suzu queue <内容> 排队发送。普通消息会优先处理。",
  });
});

test("successful steer reaches the active turn without showing a delivery notice", async () => {
  const priorWindow = globalThis.window;
  let steerInput = null;
  const contact = { agentId: "agent-steer", id: "contact-steer", name: "引导测试" };
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const snapshot = {
    activeContact: contact,
    activeSessionId: "session-steer",
    contacts: [contact],
    contactsRoot: "D:/suzu-data/contacts",
    messages: [],
    projectRoot: "D:/suzu-data/contacts/steer",
    sessions: [{ id: "session-steer", title: "引导测试" }],
    status: "ready",
    version: "steer-notice-test",
  };
  const context = {
    api: {
      conversation: {
        onEvent: () => () => {},
        snapshot: async () => snapshot,
        steer: async (input) => {
          steerInput = input;
          return {
            delivered: true,
            message: "引导已送达。",
            requestId: "request-steer",
            sessionId: snapshot.activeSessionId,
          };
        },
      },
    },
    render: () => {},
    state: { settings: { conversationPreferences: {} } },
  };

  try {
    startConversationPolling(context);
    await flush();
    const actions = createConversationReactActions(context);
    actions.setDraft("/suzu steer 直接继续");
    actions.submitMessage();
    await flush();
    await flush();

    const view = conversationReactSnapshot(context);
    assert.deepEqual(steerInput, { content: "直接继续" });
    assert.equal(view.notice, "");
    assert.equal(view.error, "");
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("Markdown replies wait for completion and stay in one coherent chat bubble", () => {
  const markdown = "# 今天的安排\n\n- 回复消息\n- 整理日记\n\n| 项目 | 状态 |\n| --- | --- |\n| 日记 | 进行中 |";
  assert.equal(hasMarkdownFormatting(markdown), true);
  assert.deepEqual(splitCompanionReplyBuffer(markdown), {
    remainder: markdown,
    sentences: [],
  });
  assert.deepEqual(splitCompanionReplyBuffer(markdown, { final: true }), {
    remainder: "",
    sentences: [markdown],
  });
  const parts = splitAssistantMessageOnBlankLines({
    id: "markdown-reply",
    kind: "assistant",
    blocks: [{ kind: "text", text: markdown }],
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].blocks[0].text, markdown);
});

test("only completed scheduled agent text replies are eligible for an outside-chat notification", () => {
  assert.equal(isScheduledAgentReply({ kind: "schedule", type: "agent-reply", content: "你那边现在怎么样？" }), true);
  assert.equal(isScheduledAgentReply({ kind: "schedule", type: "agent-reply", content: "我安排两小时后再来。", displayAsSystem: true }), false);
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

test("assistant replies split into sentence bubbles and keep the live state on the final bubble", () => {
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

  const punctuationParts = splitAssistantMessageOnBlankLines({
    id: "reply-2",
    kind: "assistant",
    blocks: [{ kind: "text", text: "Hello! Nice to meet you. 你今天怎么样？" }],
  });
  assert.deepEqual(punctuationParts.map((item) => item.blocks[0].text), ["Hello!", "Nice to meet you.", "你今天怎么样？"]);
  assert.deepEqual(latestConversationMessageSummary([{
    kind: "assistant",
    timestamp: "2026-08-28T15:33:00+08:00",
    blocks: [{ kind: "text", text: "第一句。第二句。最后一句。" }],
  }]), {
    preview: "最后一句。",
    timestamp: "2026-08-28T15:33:00+08:00",
  });
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

test("conversation queues a follow-up snapshot instead of dropping it while the first read is running", async () => {
  const priorWindow = globalThis.window;
  const resolvers = [];
  let calls = 0;
  const contact = { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" };
  const snapshot = (version, messages) => ({
    activeContact: contact,
    activeSessionId: "session-suzu",
    contacts: [contact],
    contactsRoot: "D:/suzu-data/contacts",
    historyPage: { hasMore: false, oldestEventSeq: 1 },
    messages,
    projectRoot: "D:/suzu-data/contacts/suzu",
    sessions: [{ id: "session-suzu", title: "Suzu" }],
    status: "ready",
    version,
  });
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        snapshot: () => {
          calls += 1;
          return new Promise((resolve) => resolvers.push(resolve));
        },
      },
    },
    render: () => {},
    state: { settings: { conversationPreferences: {} } },
  };

  try {
    startConversationPolling(context);
    await flush();
    assert.equal(calls, 1);

    createConversationReactActions(context).refresh();
    assert.equal(calls, 1);

    resolvers.shift()(snapshot("snapshot-one", [{
      blocks: [{ kind: "text", text: "第一条" }],
      id: "message-one",
      kind: "user",
      lineNumber: 1,
      timestamp: "2026-08-24T10:00:00.000Z",
    }]));
    await flush();
    await flush();
    assert.equal(calls, 2);

    resolvers.shift()(snapshot("snapshot-two", [{
      blocks: [{ kind: "text", text: "第二条" }],
      id: "message-two",
      kind: "assistant",
      lineNumber: 2,
      timestamp: "2026-08-24T10:00:01.000Z",
    }]));
    await flush();
    await flush();

    assert.deepEqual(
      conversationReactSnapshot(context).messageRows
        .filter((row) => row.type === "message")
        .map((row) => row.blocks[0]?.text),
      ["第一条", "第二条"],
    );
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("completed multi-step replies retire their live projection after durable history catches up", async () => {
  const priorWindow = globalThis.window;
  const contact = { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" };
  const timers = [];
  let nextTimerId = 0;
  const runNextTimer = () => {
    const timer = timers.shift();
    assert.ok(timer);
    timer.callback();
  };
  let eventListener = () => {};
  let version = "before-completion";
  let messages = [{
    blocks: [{ kind: "text", text: "处理这个文件" }],
    id: "user-request",
    kind: "user",
    lineNumber: 1,
    timestamp: "2026-08-24T10:00:00.000Z",
  }];
  const snapshot = () => ({
    activeContact: contact,
    activeSessionId: "session-suzu",
    contacts: [contact],
    contactsRoot: "D:/suzu-data/contacts",
    historyPage: { hasMore: false, oldestEventSeq: 1 },
    messages,
    projectRoot: "D:/suzu-data/contacts/suzu",
    sessions: [{ id: "session-suzu", title: "Suzu" }],
    status: "ready",
    version,
  });
  globalThis.window = {
    clearInterval: () => {},
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    setInterval: () => 1,
    setTimeout(callback, delay) {
      const timer = { callback, delay, id: ++nextTimerId };
      timers.push(timer);
      return timer;
    },
  };
  const context = {
    api: {
      conversation: {
        onEvent(listener) {
          eventListener = listener;
          return () => { eventListener = () => {}; };
        },
        snapshot: async () => snapshot(),
      },
    },
    render: () => {},
    state: { settings: { conversationPreferences: {} } },
  };
  const eventBase = {
    requestId: "turn-multi-step",
    sessionId: "session-suzu",
    projectRoot: "D:/suzu-data/contacts/suzu",
    timestamp: "2026-08-24T10:00:01.000Z",
  };

  try {
    startConversationPolling(context);
    await flush();
    eventListener({ ...eventBase, type: "reply-stream", content: "我先检查。" });
    eventListener({ ...eventBase, type: "reply-stream", content: "我先检查。检查完成。" });
    eventListener({
      ...eventBase,
      type: "reply",
      done: true,
      assistantMessageCount: 3,
      content: "我先检查。检查完成。\n\n结果如下：\n\n- 文件已保存",
    });
    assert.deepEqual(
      conversationReactSnapshot(context).messageRows
        .filter((row) => row.type === "message")
        .map((row) => row.blocks[0]?.text),
      ["处理这个文件", "我先检查。"],
    );
    assert.deepEqual(timers.map((timer) => timer.delay), [COMPLETED_REPLY_BUBBLE_INTERVAL_MS]);
    runNextTimer();
    assert.deepEqual(
      conversationReactSnapshot(context).messageRows
        .filter((row) => row.type === "message")
        .map((row) => row.blocks[0]?.text),
      ["处理这个文件", "我先检查。", "检查完成。"],
    );

    version = "after-completion";
    messages = [
      messages[0],
      { blocks: [{ kind: "text", text: "我先检查。" }], id: "step-1", kind: "assistant", lineNumber: 2, timestamp: "2026-08-24T10:00:01.000Z" },
      { blocks: [{ kind: "text", text: "检查完成。" }], id: "step-2", kind: "assistant", lineNumber: 3, timestamp: "2026-08-24T10:00:02.000Z" },
      { blocks: [{ kind: "text", text: "结果如下：\n\n- 文件已保存" }], id: "step-3", kind: "assistant", lineNumber: 4, timestamp: "2026-08-24T10:00:03.000Z" },
    ];
    eventListener({ ...eventBase, type: "turn-complete" });
    await flush();
    await flush();

    assert.deepEqual(
      conversationReactSnapshot(context).messageRows
        .filter((row) => row.type === "message")
        .map((row) => row.blocks[0]?.text),
      ["处理这个文件", "我先检查。", "检查完成。", "结果如下：\n\n- 文件已保存"],
    );
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("live replies reveal consecutive bubbles at a short interval", async () => {
  const priorWindow = globalThis.window;
  const contact = { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" };
  const timers = [];
  let eventListener = () => {};
  let nextTimerId = 0;
  const runNextTimer = () => {
    const timer = timers.shift();
    assert.ok(timer);
    timer.callback();
  };
  globalThis.window = {
    clearInterval: () => {},
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    setInterval: () => 1,
    setTimeout(callback, delay) {
      const timer = { callback, delay, id: ++nextTimerId };
      timers.push(timer);
      return timer;
    },
  };
  const context = {
    api: {
      conversation: {
        onEvent(listener) {
          eventListener = listener;
          return () => { eventListener = () => {}; };
        },
        snapshot: async () => ({
          activeContact: contact,
          activeSessionId: "session-suzu",
          contacts: [contact],
          contactsRoot: "D:/suzu-data/contacts",
          historyPage: { hasMore: false, oldestEventSeq: 1 },
          messages: [],
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "reply-reveal",
        }),
      },
    },
    render: () => {},
    state: { settings: { conversationPreferences: {} } },
  };

  try {
    startConversationPolling(context);
    await flush();
    assert.deepEqual(splitCompanionReplyBuffer("第一段\n\n第二段\n\n第三段", { final: true }).sentences, ["第一段", "第二段", "第三段"]);
    eventListener({
      content: "第一段\n\n第二段\n\n第三段",
      done: true,
      projectRoot: "D:/suzu-data/contacts/suzu",
      requestId: "turn-reveal",
      sessionId: "session-suzu",
      timestamp: "2026-08-24T10:00:01.000Z",
      type: "reply",
    });
    const visibleText = () => conversationReactSnapshot(context).messageRows
      .filter((row) => row.type === "message")
      .map((row) => row.blocks[0]?.text);

    assert.deepEqual(visibleText(), ["第一段"]);
    assert.deepEqual(timers.map((timer) => timer.delay), [COMPLETED_REPLY_BUBBLE_INTERVAL_MS]);

    runNextTimer();
    assert.deepEqual(visibleText(), ["第一段", "第二段"]);
    assert.deepEqual(timers.map((timer) => timer.delay), [COMPLETED_REPLY_BUBBLE_INTERVAL_MS]);

    runNextTimer();
    assert.deepEqual(visibleText(), ["第一段", "第二段", "第三段"]);
    assert.equal(timers.length, 0);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("renderer withholds every active-conversation surface from a stale hidden selection", async () => {
  const priorWindow = globalThis.window;
  const hiddenContact = { agentId: "agent-hidden", hidden: true, id: "contact-hidden", name: "不应显示的联系人" };
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        snapshot: async () => ({
          activeContact: hiddenContact,
          activeSessionId: "session-hidden",
          contacts: [hiddenContact],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [{ kind: "assistant", blocks: [{ kind: "text", text: "不应显示的聊天内容" }] }],
          projectRoot: "D:/suzu-data/contacts/hidden",
          sessions: [{ id: "session-hidden", title: "不应显示的联系人" }],
          status: "ready",
          version: "hidden-selection",
        }),
      },
    },
    render: () => {},
    state: { settings: { contactsRoot: "D:/suzu-data/contacts", conversationPreferences: {} } },
  };

  try {
    startConversationPolling(context);
    await flush();
    await flush();
    const view = conversationReactSnapshot(context);
    assert.equal(view.peer, "未选择联系人");
    assert.equal(view.contacts.length, 0);
    assert.equal(view.call.available, false);
    assert.equal(view.composer.unavailable, true);
    assert.equal(view.sessionSettings, null);
    assert.deepEqual(view.permissions, []);
    assert.match(view.messageRows[0]?.text || "", /设置 > 隐私/u);
    assert.doesNotMatch(JSON.stringify(view), /不应显示的聊天内容|不应显示的联系人/u);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("hiding the open contact clears its local draft and applies the replacement selection", async () => {
  const priorWindow = globalThis.window;
  const contact = { agentId: "agent-open", id: "contact-open", name: "当前联系人" };
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        snapshot: async () => ({
          activeContact: contact,
          activeSessionId: "session-open",
          contacts: [contact],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [{ kind: "assistant", blocks: [{ kind: "text", text: "原会话内容" }] }],
          projectRoot: "D:/suzu-data/contacts/open",
          sessions: [{ id: "session-open", title: "当前联系人" }],
          status: "ready",
          version: "open-selection",
        }),
        updateContactPresentation: async () => ({
          activeContact: null,
          activeSessionId: "",
          contacts: [{ ...contact, hidden: true }],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [],
          projectRoot: "",
          sessions: [],
          status: "missing",
          version: "hidden-selection",
        }),
      },
      settings: { get: async () => ({ contactsRoot: "D:/suzu-data/contacts", conversationPreferences: {} }) },
    },
    render: () => {},
    state: { settings: { contactsRoot: "D:/suzu-data/contacts", conversationPreferences: {} } },
  };

  try {
    startConversationPolling(context);
    await flush();
    await flush();
    const actions = createConversationReactActions(context);
    actions.setDraft("未发送的私密草稿");
    await actions.updateContactPresentation(contact.id, { hidden: true });
    const view = conversationReactSnapshot(context);
    assert.equal(view.peer, "未选择联系人");
    assert.equal(view.composer.draft, "");
    assert.equal(view.notice, "联系人已隐藏。可在“设置 > 隐私”中恢复。");
    assert.doesNotMatch(JSON.stringify(view), /当前联系人|原会话内容|未发送的私密草稿/u);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
