import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  claudeAllowedTools,
  claudeAllowedToolsForWorkspace,
  claudeCliArguments,
  claudeCliEnvironment,
  createConversationChatService,
  scheduleSystemPrompt,
} from "../electron/services/conversation-chat.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.input = "";
    this.killed = false;
    this.stdin.on("data", (chunk) => { this.input += chunk.toString("utf8"); });
  }

  emitJson(value) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill() {
    this.killed = true;
    return true;
  }

  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

test("Claude Code stream arguments create or resume only the selected native session", () => {
  assert.deepEqual(claudeCliArguments({ sessionId: "new-session", hasTranscript: false }), [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--replay-user-messages",
    "--permission-mode", "acceptEdits",
    "--disallowed-tools", "Agent,TodoWrite,AskUserQuestion",
    "--session-id", "new-session",
  ]);
  assert.deepEqual(claudeCliArguments({ sessionId: "saved-session", hasTranscript: true }).slice(-2), ["--resume", "saved-session"]);
  const manual = claudeCliArguments({ sessionId: "manual-session", permissionMode: "default" });
  const planned = claudeCliArguments({ sessionId: "plan-session", permissionMode: "plan" });
  const bypassed = claudeCliArguments({ sessionId: "bypass-session", permissionMode: "bypassPermissions" });
  assert.equal(manual[manual.indexOf("--permission-mode") + 1], "default");
  assert.equal(planned[planned.indexOf("--permission-mode") + 1], "plan");
  assert.equal(bypassed[bypassed.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.deepEqual(claudeAllowedTools({ read: true, webFetch: false, webSearch: true }), ["Read", "WebSearch"]);
  const allowed = claudeCliArguments({ sessionId: "allowed-tools", allowedTools: claudeAllowedToolsForWorkspace({ read: true, webFetch: true, webSearch: false }, { suzuCliCommand: "suzu-lives" }), workspaceDirectories: ["D:/Suzu/workspace"] });
  assert.match(allowed[allowed.indexOf("--allowed-tools") + 1], /^Read,WebFetch,/u);
  assert.equal(allowed[allowed.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(allowed[allowed.indexOf("--add-dir") + 1], path.resolve("D:/Suzu/workspace"));
  assert.ok(allowed[allowed.indexOf("--allowed-tools") + 1].includes("Bash(suzu-lives *)"));
});

test("Claude runtime feature settings remove only disabled built-in tools and background features", () => {
  const enabled = {
    subagents: true,
    taskList: true,
    backgroundTasks: true,
    nativeCron: true,
    askUserQuestion: true,
  };
  assert.equal(claudeCliArguments({ sessionId: "enabled", claudeRuntimeFeatures: enabled }).includes("--disallowed-tools"), false);
  assert.deepEqual(claudeCliEnvironment({ claudeRuntimeFeatures: enabled, baseEnv: { KEEP: "yes" } }), {
    KEEP: "yes",
  });
  assert.deepEqual(claudeCliEnvironment({ baseEnv: { KEEP: "yes" } }), {
    KEEP: "yes",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
  });
  const restricted = claudeCliArguments({
    sessionId: "restricted",
    claudeRuntimeFeatures: { bash: false, edit: false, glob: false, grep: false, write: false },
    claudeToolPermissions: { read: false, webFetch: false, webSearch: false },
  });
  assert.equal(restricted[restricted.indexOf("--disallowed-tools") + 1], "Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch,Agent,TodoWrite,AskUserQuestion");
});

test("schedule prompt keeps Agent scheduling scoped to proactive contact", () => {
  const proactiveOnly = scheduleSystemPrompt({
    conversationAdd: "suzu-lives schedule add --contact-id contact-suzu",
    list: "suzu-lives schedule list",
    remove: "suzu-lives schedule remove <任务ID>",
    proactiveChainPrompt: "用我的链式提示",
    proactiveFollowUpPrompt: "用我的回访提示",
  });
  assert.match(proactiveOnly, /用我的链式提示/u);
  assert.match(proactiveOnly, /用我的回访提示/u);

  const merchantOnly = scheduleSystemPrompt({
    operationAdd: "suzu-lives schedule add",
    list: "suzu-lives schedule list",
    remove: "suzu-lives schedule remove <任务ID>",
  });
  assert.equal(merchantOnly, "");
});

test("chat starts the local Claude CLI and forwards its stream", async () => {
  const root = await temporaryDirectory("suzu-direct-chat-");
  const projectRoot = path.join(root, "project");
  const workspaceDirectory = path.join(root, "suzu-workspace");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    agentAttachmentCommand: () => '"Suzu Lives Console.exe" --suzu-lives-cli conversation-attachment',
    agentScheduleCommand: () => ({
      conversationAdd: '"Suzu Lives Console.exe" --suzu-lives-cli schedule add --data-root "D:\\\\suzu" --contact-id "contact-suzu"',
      list: '"Suzu Lives Console.exe" --suzu-lives-cli schedule list --data-root "D:\\\\suzu"',
      remove: '"Suzu Lives Console.exe" --suzu-lives-cli schedule remove',
    }),
    claudeWorkspaceDirectories: [workspaceDirectory],
    settingsService: { load: () => ({ projectRoot }) },
    reader: {
      contactIdForSession: async ({ sessionId, projectRoot: sessionProjectRoot }) => (
        sessionId === "session-1" && sessionProjectRoot === projectRoot ? "contact-suzu" : ""
      ),
      ensureActiveSession: async () => ({ id: "session-1", projectRoot, hasTranscript: false, approvalMode: "plan" }),
    },
    homeDirectory,
    suzuCliCommand: '"Suzu Lives Console.exe" --suzu-lives-cli',
    spawnImpl: (command, args, options) => {
      const child = new FakeChild();
      spawned.push({ command, args, options, child });
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  const result = await service.send({ content: "直接聊天" });
  assert.equal(result.accepted, true);
  assert.equal(result.sessionId, "session-1");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, commandPath);
  assert.equal(spawned[0].options.cwd, projectRoot);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.ok(spawned[0].args.includes("--session-id"));
  assert.match(spawned[0].args[spawned[0].args.indexOf("--allowed-tools") + 1], /^Read,WebFetch,WebSearch,/u);
  assert.ok(spawned[0].args[spawned[0].args.indexOf("--allowed-tools") + 1].includes('Bash("Suzu Lives Console.exe" --suzu-lives-cli *)'));
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--add-dir") + 1], workspaceDirectory);
  assert.ok(spawned[0].args.includes("--disallowed-tools"));
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--disallowed-tools") + 1], "Agent,TodoWrite,AskUserQuestion");
  assert.equal(spawned[0].options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(spawned[0].options.env.CLAUDE_CODE_DISABLE_CRON, "1");
  const attachmentPromptIndex = spawned[0].args.indexOf("--append-system-prompt");
  assert.ok(attachmentPromptIndex >= 0);
  assert.match(spawned[0].args[attachmentPromptIndex + 1], /conversation-attachment --image/u);
  assert.match(spawned[0].args[attachmentPromptIndex + 1], /conversation-attachment --audio/u);
  assert.match(spawned[0].args[attachmentPromptIndex + 1], /schedule add --data-root/u);
  await flush();
  assert.deepEqual(JSON.parse(spawned[0].child.input.trim()), {
    type: "user",
    message: { role: "user", content: "直接聊天" },
  });

  spawned[0].child.emitJson({ type: "system", subtype: "init", slash_commands: ["/compact", { name: "/goal" }] });
  spawned[0].child.emitJson({ type: "assistant", message: { stop_reason: "tool_use", content: [
    { type: "thinking", thinking: "先检查当前项目。" },
    { type: "text", text: "先核对当前状态。" },
    { type: "tool_use", name: "Read", input: { file_path: "CLAUDE.md" } },
  ] } });
  spawned[0].child.emitJson({ type: "assistant", message: { stop_reason: "end_turn", content: [
    { type: "text", text: "我在。" },
  ] } });
  spawned[0].child.emitJson({ type: "user", message: { content: [{
    type: "tool_result",
    content: JSON.stringify({
      status: "ok",
      type: "suzu-conversation-attachment",
      receiptId: "attachment-receipt-1",
      items: [
        { kind: "file", path: path.join(projectRoot, "report.txt"), fileName: "report.txt", size: 12 },
        { kind: "audio", path: path.join(projectRoot, "voice.mp3"), fileName: "voice.mp3", size: 24 },
      ],
    }),
  }] } });
  spawned[0].child.emitJson({ type: "user", message: { content: [{
    type: "tool_result",
    content: JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      capabilityId: "voice-call",
      action: "request",
      result: { type: "suzu-voice-call-request", reason: "想听听你的声音" },
    }),
  }] } });
  spawned[0].child.emitJson({ type: "result", result: "我在。", session_id: "session-1", usage: { input_tokens: 3, output_tokens: 2 } });
  spawned[0].child.close();
  await flush();
  assert.equal(events.find((event) => event.type === "reply-stream")?.content, "我在。");
  assert.deepEqual(events.filter((event) => event.type === "agent-reply").map((event) => event.content), ["我在。"]);
  assert.equal(events.find((event) => event.type === "agent-reply")?.deliverToWechat, false);
  assert.equal(events.some((event) => event.type === "reply-stream" && event.content.includes("先核对当前状态。")), false);
  assert.equal(events.some((event) => event.type === "agent-reply" && event.content.includes("先核对当前状态。")), false);
  assert.equal(events.find((event) => event.type === "reply")?.done, true);
  assert.equal(events.find((event) => event.type === "turn-complete")?.sessionId, "session-1");
  assert.equal(events.find((event) => event.type === "reply")?.projectRoot, projectRoot);
  assert.match(events.find((event) => event.type === "thinking")?.content || "", /先检查/u);
  assert.match(events.filter((event) => event.type === "thinking").map((event) => event.content).join("\n"), /先核对当前状态/u);
  assert.match(events.find((event) => event.type === "tool")?.content || "", /Read/u);
  assert.match(events.find((event) => event.type === "usage")?.content || "", /合计 5/u);
  assert.deepEqual(events.find((event) => event.type === "slash-commands")?.commands, ["/compact", "/goal"]);
  assert.deepEqual(events.find((event) => event.type === "agent-media")?.media, [{
    kind: "file",
    path: path.join(projectRoot, "report.txt"),
    fileName: "report.txt",
    size: 12,
  }, {
    kind: "audio",
    path: path.join(projectRoot, "voice.mp3"),
    fileName: "voice.mp3",
    size: 24,
  }]);
  const callRequest = events.find((event) => event.type === "call-request");
  assert.equal(callRequest?.contactId, "contact-suzu");
  assert.equal(callRequest?.reason, "想听听你的声音");
  assert.match(callRequest?.requestId || "", /^suzu-.*:voice-call$/u);
});

test("chat keeps the memory archive lifecycle while UserPromptSubmit owns recall", async () => {
  const root = await temporaryDirectory("suzu-embedded-memory-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const calls = [];
  const spawned = [];
  const memoryRuntime = {
    prepareTurn: async (value) => {
      calls.push({ type: "prepare", value });
      return { archiveTurn: "memory-turn-1" };
    },
    completeTurn: async (turn, value) => { calls.push({ type: "complete", turn, value }); },
    abortTurn: async (turn) => { calls.push({ type: "abort", turn }); },
  };
  const service = createConversationChatService({
    homeDirectory,
    memoryRuntime,
    reader: { ensureActiveSession: async () => ({ id: "session-memory", projectRoot, hasTranscript: false }) },
    settingsService: { load: () => ({ projectRoot }) },
    spawnImpl: (_command, args, options) => {
      const child = new FakeChild();
      spawned.push({ args, child, options });
      return child;
    },
  });

  await service.send({ content: "记得我们上次聊的事情吗？" });
  assert.equal(calls[0]?.type, "prepare");
  assert.equal(calls[0]?.value.userText, "记得我们上次聊的事情吗？");
  assert.equal(spawned[0].args.some((value) => String(value).includes("suzu-long-term-memory")), false);

  spawned[0].child.emitJson({ type: "result", result: "我记得。" });
  spawned[0].child.close();
  await flush();
  await flush();
  const completed = calls.find((item) => item.type === "complete");
  assert.equal(completed?.turn?.archiveTurn, "memory-turn-1");
  assert.equal(completed?.value?.assistantText, "我记得。");
  assert.equal(calls.some((item) => item.type === "abort"), false);
});

test("live chat renders long-term-memory Hook context as a system message", async () => {
  const root = await temporaryDirectory("suzu-memory-hook-context-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    homeDirectory,
    onEvent: (event) => events.push(event),
    reader: { ensureActiveSession: async () => ({ id: "memory-context-session", projectRoot, hasTranscript: false }) },
    settingsService: { load: () => ({ projectRoot }) },
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
  });

  await service.send({ content: "还记得我们上次去的地方吗？" });
  spawned[0].emitJson({
    type: "hook_additional_context",
    attachment: { content: "内部说明\n<suzu-long-term-memory>私有回忆</suzu-long-term-memory>" },
  });
  await flush();
  assert.equal(events.some((event) => event.type === "attachment" && /私有回忆/u.test(event.content || "")), false);
  assert.equal(events.some((event) => event.type === "system" && event.content === "记忆召回\n私有回忆"), true);
  spawned[0].emitJson({ type: "result", result: "记得。" });
  spawned[0].close();
  service.dispose();
});

test("iPhone feedback is archived by embedded memory without treating scheduled prompts as user memory", async () => {
  const root = await temporaryDirectory("suzu-embedded-memory-sources-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const prepared = [];
  const spawned = [];
  const service = createConversationChatService({
    homeDirectory,
    memoryRuntime: {
      prepareTurn: async (value) => {
        prepared.push(value);
        return { archiveTurn: "iphone-feedback" };
      },
      completeTurn: async () => undefined,
      abortTurn: async () => undefined,
    },
    reader: { ensureActiveSession: async () => ({ id: "session-sources", projectRoot, hasTranscript: false }) },
    settingsService: { load: () => ({ projectRoot }) },
    spawnImpl: (_command, args, options) => {
      const child = new FakeChild();
      spawned.push({ args, child, options });
      return child;
    },
  });

  await service.sendToSession({
    content: "这是 iPhone 反馈。",
    sessionId: "session-sources",
    projectRoot,
    kind: "iphone-feedback",
  });
  assert.equal(prepared.length, 1);
  spawned[0].child.emitJson({ type: "result", result: "收到反馈。" });
  spawned[0].child.close();
  await flush();

  await service.sendToSession({
    content: "<suzu-schedule-task>内部任务</suzu-schedule-task>",
    sessionId: "session-sources",
    projectRoot,
    hasTranscript: true,
    kind: "schedule",
  });
  assert.equal(prepared.length, 1);
  spawned[1].child.close();
  await flush();
});

test("scheduled turns hide NO_REPLY and deliver a visible answer only after completion", async () => {
  const root = await temporaryDirectory("suzu-scheduled-chat-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "unused", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  await service.sendToSession({
    content: "<suzu-schedule-task>\\n检查回访是否需要回复\\n</suzu-schedule-task>",
    sessionId: "scheduled-session",
    projectRoot,
    hasTranscript: true,
    kind: "schedule",
  });
  spawned[0].emitJson({ type: "assistant", message: { content: [{ type: "text", text: "NO_REPLY" }] } });
  spawned[0].emitJson({ type: "result", result: "NO_REPLY" });
  spawned[0].close();
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "agent-reply"), []);
  assert.deepEqual(events.filter((event) => event.type === "reply"), []);

  await service.sendToSession({
    content: "<suzu-schedule-task>\\n自然回访\\n</suzu-schedule-task>",
    contactId: "contact-a1b2c3d4-1111-2222-3333-444444444444",
    sessionId: "scheduled-session",
    projectRoot,
    hasTranscript: true,
    kind: "schedule",
  });
  spawned[1].emitJson({ type: "assistant", message: { content: [{ type: "text", text: "你那边现在怎么样？" }] } });
  spawned[1].emitJson({ type: "result", result: "你那边现在怎么样？" });
  spawned[1].close();
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "agent-reply").map((event) => event.content), ["你那边现在怎么样？"]);
  assert.equal(events.filter((event) => event.type === "agent-reply").at(-1)?.contactId, "contact-a1b2c3d4-1111-2222-3333-444444444444");
  assert.equal(events.filter((event) => event.type === "agent-reply").at(-1)?.deliverToWechat, true);
  assert.equal(events.filter((event) => event.type === "reply").at(-1)?.done, true);
  service.dispose();
});

test("a WeChat image and file become one native Claude multimodal user message", async () => {
  const root = await temporaryDirectory("suzu-wechat-inbound-chat-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  const imagePath = path.join(root, "inbound-image.png");
  const filePath = path.join(root, "inbound-file.txt");
  await Promise.all([
    fs.mkdir(projectRoot, { recursive: true }),
    fs.mkdir(path.dirname(commandPath), { recursive: true }),
  ]);
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "unused", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
  });

  await service.sendToSession({
    content: "这是微信带来的附件",
    sessionId: "wechat-session",
    projectRoot,
    hasTranscript: true,
    media: [
      { kind: "image", path: imagePath, fileName: "photo.png", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { kind: "file", path: filePath, fileName: "report.txt", data: Buffer.from("文件内容") },
    ],
  });
  await flush();
  const input = JSON.parse(spawned[0].input.trim());
  assert.equal(input.type, "user");
  assert.equal(input.message.role, "user");
  assert.equal(Array.isArray(input.message.content), true);
  assert.deepEqual(input.message.content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
  });
  assert.match(input.message.content.at(-1).text, /这是微信带来的附件/u);
  assert.match(input.message.content.at(-1).text, /<suzu-wechat-media>/u);
  assert.ok(input.message.content.at(-1).text.includes(JSON.stringify(filePath).slice(1, -1)));
  service.dispose();
});

test("a favorite sticker keeps its image and sends an explicit sticker meaning to Claude", async () => {
  const root = await temporaryDirectory("suzu-sticker-inbound-chat-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  const stickerPath = path.join(root, "cheer.gif");
  await Promise.all([
    fs.mkdir(projectRoot, { recursive: true }),
    fs.mkdir(path.dirname(commandPath), { recursive: true }),
    fs.writeFile(stickerPath, Buffer.from("GIF89a-sticker")),
  ]);
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "unused", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
  });

  await service.sendToSession({
    content: "",
    memoryText: "用户发送了一个表情包：cheer.gif",
    media: [{
      data: Buffer.from("GIF89a-sticker"),
      fileName: "cheer.gif",
      kind: "image",
      mimeType: "image/gif",
      path: stickerPath,
    }],
    mediaSource: "sticker",
    projectRoot,
    sessionId: "sticker-session",
  });
  await flush();

  const input = JSON.parse(spawned[0].input.trim());
  assert.deepEqual(input.message.content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/gif", data: Buffer.from("GIF89a-sticker").toString("base64") },
  });
  assert.match(input.message.content.at(-1).text, /<suzu-sticker>/u);
  assert.match(input.message.content.at(-1).text, /"source":"suzu-sticker"/u);
  assert.match(input.message.content.at(-1).text, /不要当成普通照片或文件附件/u);
  service.dispose();
});

test("messages in the same Claude session run in FIFO order", async () => {
  const root = await temporaryDirectory("suzu-chat-queue-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "queue-session", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: (_command, args) => {
      const child = new FakeChild();
      spawned.push({ args, child });
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  const first = await service.send({ content: "第一条" });
  const second = await service.send({ content: "第二条" });
  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.equal(second.queuePosition, 1);
  assert.equal(spawned.length, 1);

  spawned[0].child.emitJson({ type: "result", result: "第一条完成" });
  await flush();
  await flush();
  assert.equal(spawned.length, 1);
  const sent = spawned[0].child.input.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(sent[1], {
    type: "user",
    message: { role: "user", content: "第二条" },
  });
  assert.ok(spawned[0].args.includes("--session-id"));
  assert.ok(events.some((event) => event.type === "queue" && event.items.some((item) => item.requestId === second.requestId)));
  spawned[0].child.emitJson({ type: "result", result: "第二条完成" });
  await flush();
  service.dispose();
});

test("proactive scheduled turns remain observable while active or queued", async () => {
  const root = await temporaryDirectory("suzu-proactive-queue-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "proactive-queue-session", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
  });
  const scheduledTurn = {
    contactId: "contact-proactive-queue",
    hasTranscript: false,
    kind: "schedule",
    projectRoot,
    scheduleSource: "proactive-chain",
    sessionId: "proactive-queue-session",
  };

  const first = await service.sendToSession({ ...scheduledTurn, content: "第一条主动关心" });
  const second = await service.sendToSession({ ...scheduledTurn, content: "第二条主动关心" });
  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.equal(service.hasPendingTurn({
    contactId: scheduledTurn.contactId,
    kind: "schedule",
    scheduleSource: "proactive-chain",
  }), true);

  spawned[0].emitJson({ type: "result", result: "第一条完成" });
  spawned[0].close();
  await flush();
  await flush();
  assert.equal(spawned.length, 2);
  assert.equal(service.hasPendingTurn({
    contactId: scheduledTurn.contactId,
    kind: "schedule",
    scheduleSource: "proactive-chain",
  }), true);

  spawned[1].emitJson({ type: "result", result: "第二条完成" });
  spawned[1].close();
  await flush();
  await flush();
  assert.equal(service.hasPendingTurn({
    contactId: scheduledTurn.contactId,
    kind: "schedule",
    scheduleSource: "proactive-chain",
  }), false);
  service.dispose();
});

test("plain text reuses one Claude stream and closes it after the idle timeout", async () => {
  const root = await temporaryDirectory("suzu-chat-idle-stream-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "idle-session", projectRoot, hasTranscript: true }) },
    homeDirectory,
    idleStreamTimeoutMs: 100,
    idleStreamCloseGraceMs: 1_000,
    spawnImpl: (_command, args) => {
      const child = new FakeChild();
      spawned.push({ args, child });
      return child;
    },
  });

  await service.send({ content: "第一句" });
  assert.deepEqual(spawned[0].args.slice(-2), ["--resume", "idle-session"]);
  spawned[0].child.emitJson({ type: "result", result: "第一句完成" });
  await flush();
  await flush();
  assert.equal(spawned[0].child.stdin.writableEnded, false);

  const second = await service.send({ content: "第二句" });
  assert.equal(second.queued, false);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].child.input.trim().split("\n").map((line) => JSON.parse(line)).map((item) => item.message.content), ["第一句", "第二句"]);

  spawned[0].child.emitJson({ type: "result", result: "第二句完成" });
  await flush();
  await wait(130);
  assert.equal(spawned[0].child.stdin.writableEnded, true);
  spawned[0].child.close();
  service.dispose();
});

test("normal text and an active voice call share one Claude stream", async () => {
  const root = await temporaryDirectory("suzu-chat-shared-stream-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "shared-session", projectRoot, hasTranscript: true }) },
    homeDirectory,
    spawnImpl: (_command, args) => {
      const child = new FakeChild();
      spawned.push({ args, child });
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  await service.send({ content: "先打一条普通文字" });
  const promptIndex = spawned[0].args.indexOf("--append-system-prompt");
  assert.match(spawned[0].args[promptIndex + 1], /suzu-voice-call-turn/u);
  spawned[0].child.emitJson({ type: "result", result: "普通文字完成" });
  await flush();
  await flush();

  const call = await service.sendToSession({
    content: "这是通话里说的一句",
    sessionId: "shared-session",
    projectRoot,
    hasTranscript: true,
    kind: "call",
    requestId: "suzu-call-shared-stream",
  });
  assert.equal(call.queued, false);
  assert.equal(spawned.length, 1);
  const inputs = spawned[0].child.input.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(inputs[0].message.content, "先打一条普通文字");
  assert.match(inputs[1].message.content, /^<suzu-voice-call-turn>/u);
  assert.match(inputs[1].message.content, /"transcript":"这是通话里说的一句"/u);

  spawned[0].child.emitJson({ type: "result", result: "通话回复完成" });
  await flush();
  await flush();
  assert.equal(events.find((event) => event.requestId === "suzu-call-shared-stream" && event.type === "reply")?.kind, "call");

  await service.send({ content: "通话后继续打字" });
  assert.equal(spawned.length, 1);
  assert.equal(inputs.length, 2);
  const thirdInput = JSON.parse(spawned[0].child.input.trim().split("\n")[2]);
  assert.equal(thirdInput.message.content, "通话后继续打字");
  service.dispose();
});

test("call opening stays hidden from Claude's user transcript while the existing memory lifecycle receives call context", async () => {
  const root = await temporaryDirectory("suzu-chat-call-open-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const prepared = [];
  const completed = [];
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "call-open-session", projectRoot, hasTranscript: true }) },
    homeDirectory,
    memoryRuntime: {
      prepareTurn: async (value) => {
        prepared.push(value);
        return { archiveTurn: value.turnId };
      },
      completeTurn: async (turn, value) => { completed.push({ turn, value }); },
      abortTurn: async () => undefined,
    },
    spawnImpl: (_command, args) => {
      const child = new FakeChild();
      spawned.push({ args, child });
      return child;
    },
  });

  await service.sendToSession({
    content: "",
    sessionId: "call-open-session",
    projectRoot,
    hasTranscript: true,
    kind: "call-open",
    requestId: "suzu-call-open-fixture",
  });
  const promptIndex = spawned[0].args.indexOf("--append-system-prompt");
  assert.match(spawned[0].args[promptIndex + 1], /suzu-voice-call-open/u);
  const openingInput = JSON.parse(spawned[0].child.input.trim());
  assert.match(openingInput.message.content, /^<suzu-voice-call-open>/u);
  assert.doesNotMatch(openingInput.message.content, /用户打来了电话/u);
  assert.match(prepared[0].userText, /系统事件：实时语音通话已接通/u);
  assert.match(prepared[0].userText, /不是用户说的话/u);

  spawned[0].child.emitJson({ type: "result", result: "喂，我在。" });
  await flush();
  await flush();
  assert.equal(completed[0]?.value?.assistantText, "喂，我在。");

  await service.sendToSession({
    content: "能听见吗？",
    sessionId: "call-open-session",
    projectRoot,
    hasTranscript: true,
    kind: "call",
    requestId: "suzu-call-turn-fixture",
  });
  const callInput = JSON.parse(spawned[0].child.input.trim().split("\n")[1]);
  assert.match(callInput.message.content, /^<suzu-voice-call-turn>/u);
  assert.match(prepared[1].userText, /来自用户与联系人的实时语音通话/u);
  assert.match(prepared[1].userText, /能听见吗？/u);
  service.dispose();
});

test("a recalled turn stays on the existing Claude stream", async () => {
  const root = await temporaryDirectory("suzu-chat-memory-stream-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  let includeRecall = false;
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "memory-stream-session", projectRoot, hasTranscript: true }) },
    homeDirectory,
    memoryRuntime: {
      prepareTurn: async () => ({ legacyRecall: includeRecall ? "<suzu-long-term-memory>本轮召回</suzu-long-term-memory>" : "" }),
      completeTurn: async () => undefined,
      abortTurn: async () => undefined,
    },
    spawnImpl: (_command, args) => {
      const child = new FakeChild();
      spawned.push({ args, child });
      return child;
    },
  });

  await service.send({ content: "不需要召回的第一句" });
  spawned[0].child.emitJson({ type: "result", result: "第一句完成" });
  await flush();
  await flush();

  includeRecall = true;
  await service.send({ content: "需要按本轮召回的第二句" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].child.stdin.writableEnded, false);
  assert.equal(spawned[0].args.some((value) => String(value).includes("本轮召回")), false);
  assert.match(spawned[0].child.input, /需要按本轮召回的第二句/u);
  spawned[0].child.close();
  service.dispose();
});

test("copied Claude session ids remain isolated by project root", async () => {
  const root = await temporaryDirectory("suzu-chat-project-scope-");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true }), fs.mkdir(path.dirname(commandPath), { recursive: true })]);
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot: projectA }) },
    reader: {
      approvalModeForSession: async ({ projectRoot: requestedProjectRoot }) => requestedProjectRoot === projectA ? "plan" : "bypassPermissions",
      ensureActiveSession: async () => ({ id: "unused", projectRoot: projectA, hasTranscript: false }),
    },
    homeDirectory,
    spawnImpl: (_command, args, options) => {
      const child = new FakeChild();
      spawned.push({ args, child, options });
      return child;
    },
  });

  await service.sendToSession({ content: "项目 A", sessionId: "copied-session", projectRoot: projectA });
  await service.sendToSession({ content: "项目 B", sessionId: "copied-session", projectRoot: projectB });
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].options.cwd, projectA);
  assert.equal(spawned[1].options.cwd, projectB);
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(spawned[1].args[spawned[1].args.indexOf("--permission-mode") + 1], "bypassPermissions");

  const stopped = service.stop({ sessionId: "copied-session", projectRoot: projectA });
  assert.equal(stopped.stopped, true);
  assert.equal(spawned[0].child.killed, true);
  assert.equal(spawned[1].child.killed, false);
  service.dispose();
});

test("stop interrupts only the active turn and preserves the normal message queue", async () => {
  const root = await temporaryDirectory("suzu-chat-stop-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "stop-session", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  await service.send({ content: "正在执行的任务" });
  await service.send({ content: "排队的消息" });
  const stopped = service.stop({ sessionId: "stop-session" });
  assert.equal(stopped.stopped, true);
  assert.equal(spawned[0].killed, true);

  spawned[0].close(1, "SIGTERM");
  await flush();
  await flush();
  assert.equal(events.find((event) => event.type === "turn-stopped")?.sessionId, "stop-session");
  assert.equal(spawned.length, 2);
  assert.equal(JSON.parse(spawned[1].input.trim()).message.content, "排队的消息");
  service.dispose();
});

test("request-scoped stop can remove a queued voice turn before it starts", async () => {
  const root = await temporaryDirectory("suzu-call-queue-stop-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "call-stop-session", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  await service.send({ content: "普通长任务" });
  const queued = await service.sendToSession({
    content: "会被打断的通话内容",
    sessionId: "call-stop-session",
    projectRoot,
    kind: "call",
    requestId: "suzu-call-queued-turn",
  });
  assert.equal(queued.queued, true);
  const stopped = service.stop({
    sessionId: "call-stop-session",
    projectRoot,
    requestId: "suzu-call-queued-turn",
  });
  assert.deepEqual(stopped, {
    accepted: true,
    stopped: true,
    sessionId: "call-stop-session",
    message: "已从队列中移除这次回复。",
  });
  assert.equal(events.find((event) => event.requestId === "suzu-call-queued-turn" && event.type === "turn-stopped")?.kind, "call");

  spawned[0].emitJson({ type: "result", result: "普通任务结束" });
  spawned[0].close();
  await flush();
  await flush();
  assert.equal(spawned.length, 1);
  service.dispose();
});

test("steer writes a correction into the active Claude stream without terminating the current task", async () => {
  const root = await temporaryDirectory("suzu-chat-steer-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const spawned = [];
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "steer-session", projectRoot, hasTranscript: false }) },
    homeDirectory,
    spawnImpl: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
  });

  await service.send({ content: "原任务" });
  await service.send({ content: "普通排队消息" });
  const correction = await service.steer({ content: "请先只读分析，不要修改文件" });
  assert.equal(correction.delivered, true);
  assert.equal(spawned[0].killed, false);
  const directInputs = spawned[0].input.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(directInputs.length, 2);
  assert.equal(directInputs[0].message.content, "原任务");
  assert.equal(directInputs[1].message.content, "请先只读分析，不要修改文件");

  spawned[0].emitJson({ type: "result", result: "已按引导调整" });
  spawned[0].close();
  await flush();
  await flush();
  assert.equal(spawned.length, 2);
  assert.equal(JSON.parse(spawned[1].input.trim()).message.content, "普通排队消息");
  service.dispose();
});

test("tool permission is returned only to the Claude process that requested it", async () => {
  const root = await temporaryDirectory("suzu-direct-permission-");
  const projectRoot = path.join(root, "project");
  const homeDirectory = path.join(root, "home");
  const commandPath = path.join(homeDirectory, ".local", "bin", "claude.exe");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, "fixture");
  const events = [];
  let child;
  const service = createConversationChatService({
    settingsService: { load: () => ({ projectRoot }) },
    reader: { ensureActiveSession: async () => ({ id: "session-2", projectRoot, hasTranscript: true }) },
    homeDirectory,
    spawnImpl: () => {
      child = new FakeChild();
      return child;
    },
    onEvent: (event) => events.push(event),
  });

  await service.send({ content: "请读取项目文件" });
  child.emitJson({
    type: "control_request",
    request_id: "permission-1",
    request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: "CLAUDE.md" } },
  });
  await flush();
  assert.equal(events.find((event) => event.type === "permission")?.toolName, "Read");

  assert.deepEqual(
    service.respondPermissionForSession({ sessionId: "another-session", projectRoot, behavior: "allow" }),
    { accepted: false, reason: "no-pending-permission" },
  );
  const response = service.respondPermissionForSession({ sessionId: "session-2", projectRoot, behavior: "allow" });
  assert.equal(response.accepted, true);
  assert.equal(response.toolName, "Read");
  assert.equal(events.find((event) => event.type === "permission-resolved")?.requestId, "permission-1");
  await flush();
  const messages = child.input.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages[1], {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "permission-1",
      response: { behavior: "allow", updatedInput: { file_path: "CLAUDE.md" } },
    },
  });
  child.emitJson({ type: "result", result: "已读取。" });
  child.close();
});
