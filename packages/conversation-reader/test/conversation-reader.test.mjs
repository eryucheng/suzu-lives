import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDisplayMessages, JsonlTail, normalizeUsage, readTranscriptWindow, searchTranscript } from "../src/index.mjs";

async function fixture(lines) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-conversation-")); const filePath = path.join(directory, "session.jsonl"); await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n"); return filePath; }

test("tail reads once, appends incrementally, and rescans after truncation", async () => {
  const filePath = await fixture([{ type: "user", message: { content: "first" } }, { broken: true }]);
  const tail = new JsonlTail(filePath, 10); await tail.refresh(); assert.equal(tail.records.length, 2); const firstVersion = tail.version;
  await fs.appendFile(filePath, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "added" }] } })}\n`); await tail.refresh(); assert.equal(tail.records.at(-1).type, "assistant"); assert.ok(tail.version > firstVersion);
  await fs.writeFile(filePath, `${JSON.stringify({ type: "system", content: "rewritten" })}\nnot json\n`); await tail.refresh(); assert.equal(tail.records.length, 1); assert.equal(tail.records[0].content, "rewritten"); assert.equal(tail.malformedLines, 1);
});

test("search scans records older than the in-memory tail and excludes binary payloads", async () => {
  const filePath = await fixture([{ type: "user", message: { content: "早期中文目标" } }, { type: "user", message: { content: "later", base64: "SECRET_BINARY_NEEDLE" } }]);
  const tail = new JsonlTail(filePath, 1); await tail.refresh(); assert.equal(tail.records.length, 1);
  const found = await searchTranscript(filePath, "早期中文目标"); assert.equal(found.matches.length, 1); assert.equal(found.matches[0].messages[0].kind, "user");
  const binary = await searchTranscript(filePath, "SECRET_BINARY_NEEDLE"); assert.equal(binary.matches.length, 0);
});

test("display model covers user, assistant blocks, system, attachment, and tool result", () => {
  const messages = buildDisplayMessages([{ type: "user", message: { content: "hello" } }, { type: "assistant", message: { content: [{ type: "thinking", thinking: "reason" }, { type: "tool_use", name: "Read", input: { file_path: "a.txt" } }, { type: "text", text: "answer" }] } }, { type: "user", message: { content: [{ type: "tool_result", content: "done" }] } }, { type: "system", content: "system" }, { type: "attachment", attachment: { type: "hook_additional_context", content: "context" } }]);
  assert.deepEqual(messages.map((message) => message.kind), ["user", "assistant", "system", "system", "attachment"]); assert.deepEqual(messages[1].blocks.map((block) => block.kind), ["thinking", "tool_use", "text"]); assert.equal(messages[2].blocks[0].kind, "tool_result");
});

test("managed Skill context injected by Claude never becomes a user chat bubble", () => {
  const messages = buildDisplayMessages([
    { type: "user", timestamp: "2026-08-07T16:48:32.531Z", message: { content: "还好，你能发语音给我听吗" } },
    {
      type: "user",
      timestamp: "2026-08-07T16:48:43.678Z",
      message: {
        content: "Base directory for this skill: D:\\Apps\\Suzu lives\\contact-demo\\.claude\\skills\\voice-message\n\n<!-- suzu-lives:ability:voice-message -->\n# 发送语音\n\n这是自动注入的执行上下文。",
      },
    },
  ]);
  assert.deepEqual(messages.map((message) => message.blocks[0].text), ["还好，你能发语音给我听吗"]);
});

test("Claude internal resume records stay out of chat without hiding real matching text", () => {
  const messages = buildDisplayMessages([
    { type: "user", uuid: "real-user", message: { content: "Continue from where you left off." } },
    { type: "user", uuid: "resume-meta", isMeta: true, message: { content: "Continue from where you left off." } },
    {
      type: "assistant",
      parentUuid: "resume-meta",
      message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    },
    {
      type: "assistant",
      parentUuid: "real-user",
      message: { model: "claude-test", content: [{ type: "text", text: "No response requested." }] },
    },
    { type: "user", message: { content: "这是真实的下一句话。" } },
  ]);
  assert.deepEqual(messages.map((message) => [message.kind, message.blocks[0].text]), [
    ["user", "Continue from where you left off."],
    ["assistant", "No response requested."],
    ["user", "这是真实的下一句话。"],
  ]);
});

test("voice call protocol rows render only the spoken transcript", () => {
  const messages = buildDisplayMessages([{
    type: "user",
    message: {
      content: "<suzu-voice-call-turn>\n{\"source\":\"suzu-live-call\",\"transcript\":\"你好，能听见我说话吗？\"}\n</suzu-voice-call-turn>",
    },
  }]);
  assert.deepEqual(messages.map((message) => message.blocks[0].text), ["你好，能听见我说话吗？"]);
});

test("search categories return real media and date records that can be reopened around their source line", async () => {
  const imagePath = path.join(os.tmpdir(), "suzu-search-image.png");
  const filePath = await fixture([
    { type: "user", uuid: "older-message", timestamp: "2026-08-04T10:00:00.000Z", message: { content: "前一条聊天内容" } },
    { type: "assistant", uuid: "image-message", timestamp: "2026-08-05T10:00:00.000Z", message: { content: [{ type: "tool_result", content: JSON.stringify({ status: "ok", type: "suzu-conversation-attachment", receiptId: "search-image", items: [{ kind: "image", path: imagePath, fileName: "search-image.png", size: 12 }] }) }] } },
    { type: "assistant", uuid: "link-message", timestamp: "2026-08-05T10:01:00.000Z", message: { content: [{ type: "text", text: "查看 https://example.test/search" }] } },
  ]);

  const images = await searchTranscript(filePath, { category: "images" });
  assert.equal(images.category, "images");
  assert.equal(images.matches.length, 1);
  assert.equal(images.matches[0].messageId, "image-message");

  const links = await searchTranscript(filePath, { category: "links" });
  assert.equal(links.matches.length, 1);
  assert.equal(links.matches[0].messageId, "link-message");

  const byDate = await searchTranscript(filePath, { category: "date", query: "2026-08-05" });
  assert.equal(byDate.matches.length, 2);

  const window = await readTranscriptWindow(filePath, images.matches[0].lineNumber, { before: 1, after: 1 });
  assert.equal(window.focusLineNumber, images.matches[0].lineNumber);
  assert.deepEqual(window.messages.map((message) => message.id), ["older-message", "image-message", "link-message"]);
  assert.equal(window.messages[1].lineNumber, images.matches[0].lineNumber);
});

test("scheduled task inputs are centered system notices and NO_REPLY stays hidden", () => {
  const messages = buildDisplayMessages([
    { type: "user", message: { content: "<suzu-schedule-task>\\n内部任务\\n</suzu-schedule-task>" } },
    { type: "assistant", message: { content: [{ type: "text", text: "NO_REPLY" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "正常回复" }] } },
  ]);
  assert.deepEqual(messages.map((message) => message.kind), ["system", "assistant"]);
  assert.equal(messages[0].blocks[0].text, "自动任务已触发");
  assert.equal(messages[1].blocks[0].text, "正常回复");
});

test("timer and merchant markers stay local system notices", () => {
  const messages = buildDisplayMessages([
    { type: "user", message: { content: "<suzu-schedule-task>\n任务说明：链式主动关心\n内部任务\n</suzu-schedule-task>" } },
    { type: "user", message: { content: "<suzu-merchant-task>\n内部商人投递\n</suzu-merchant-task>" } },
  ]);
  assert.deepEqual(messages.map((message) => message.kind), ["system", "system"]);
  assert.equal(messages[0].blocks[0].text, "定时器触发：链式主动关心");
  assert.equal(messages[1].blocks[0].text, "远行商人已检查");
});

test("Suzu attachment tool receipts render as agent media in the current conversation", () => {
  const filePath = path.join(os.tmpdir(), "suzu-agent-report.txt");
  const messages = buildDisplayMessages([{
    type: "user",
    timestamp: "2026-08-04T10:03:00.000Z",
    message: { content: [{
      type: "tool_result",
      content: JSON.stringify({
        status: "ok",
        type: "suzu-conversation-attachment",
        receiptId: "attachment-receipt-1",
        items: [
          { kind: "image", path: path.join(os.tmpdir(), "suzu-agent-image.png"), fileName: "image.png", size: 40 },
          { kind: "audio", path: path.join(os.tmpdir(), "suzu-agent-voice.mp3"), fileName: "voice.mp3", size: 1024 },
          { kind: "file", path: filePath, fileName: "report.txt", size: 2048 },
        ],
      }),
    }] },
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "assistant");
  assert.deepEqual(messages[0].blocks.map((block) => block.kind), ["media", "media", "media"]);
  assert.equal(messages[0].blocks[0].mediaKind, "image");
  assert.equal(messages[0].blocks[1].mediaKind, "audio");
  assert.equal(messages[0].blocks[1].fileName, "voice.mp3");
  assert.equal(messages[0].blocks[2].fileName, "report.txt");
  assert.match(messages[0].blocks[2].fileUrl, /^file:/u);
});

test("WeChat media manifests render as the current user's image and file cards", () => {
  const imagePath = path.join(os.tmpdir(), "suzu-wechat-image.png");
  const filePath = path.join(os.tmpdir(), "suzu-wechat-file.txt");
  const manifest = JSON.stringify({
    source: "wechat",
    items: [
      { kind: "image", path: imagePath, fileName: "photo.png", size: 40 },
      { kind: "file", path: filePath, fileName: "report.txt", size: 2048 },
    ],
  });
  const messages = buildDisplayMessages([{
    type: "user",
    timestamp: "2026-08-05T10:03:00.000Z",
    message: { content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
      { type: "text", text: `图片说明\n\n<suzu-wechat-media>${manifest}</suzu-wechat-media>` },
    ] },
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "user");
  assert.deepEqual(messages[0].blocks.map((block) => block.kind), ["text", "media", "media"]);
  assert.equal(messages[0].blocks[1].mediaKind, "image");
  assert.equal(messages[0].blocks[1].mediaSource, "wechat");
  assert.equal(messages[0].blocks[2].fileName, "report.txt");
  assert.match(messages[0].blocks[2].fileUrl, /^file:/u);
});

test("iPhone feedback manifests render as the current user's image cards", () => {
  const imagePath = path.join(os.tmpdir(), "suzu-iphone-image.png");
  const manifest = JSON.stringify({
    source: "iphone",
    items: [{ kind: "image", path: imagePath, fileName: "phone-photo.png", size: 40 }],
  });
  const messages = buildDisplayMessages([{
    type: "user",
    timestamp: "2026-08-05T10:04:00.000Z",
    message: { content: [{ type: "text", text: `来自手机的反馈\n\n<suzu-wechat-media>${manifest}</suzu-wechat-media>` }] },
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "user");
  assert.deepEqual(messages[0].blocks.map((block) => block.kind), ["text", "media"]);
  assert.equal(messages[0].blocks[1].mediaSource, "iphone");
  assert.equal(messages[0].blocks[1].fileName, "phone-photo.png");
});

test("display messages read reverse-order transcript records as a normal chat", () => {
  const messages = buildDisplayMessages([
    { type: "assistant", timestamp: "2026-08-02T10:02:00.000Z", message: { content: [{ type: "text", text: "later" }] } },
    { type: "user", timestamp: "2026-08-02T10:01:00.000Z", message: { content: "first" } },
  ]);
  assert.deepEqual(messages.map((message) => message.blocks[0].text), ["first", "later"]);
});

test("normalizes Claude and compatibility token usage without inventing missing fields", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 400 }, "claude"), { model: "claude", input: 1000, cacheCreation: 200, cacheRead: 300, output: 400, total: 1900 });
  assert.deepEqual(normalizeUsage({ promptTokens: 10, completion_tokens: 5 }), { model: "", input: 10, cacheCreation: null, cacheRead: null, output: 5, total: 15 });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ input_tokens: null, output_tokens: 4 }).input, null);
});
