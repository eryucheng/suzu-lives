import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableAgentId } from "@suzu-lives/agent-registry";
import {
  createWeChatLinkService,
  splitWechatText,
} from "../electron/services/wechat-link.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

function encryptAes128Ecb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function binaryResponse(value) {
  const content = Buffer.from(value);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
    text: async () => "",
  };
}

test("WeChat text delivery splits blank paragraphs before the iLink size limit", () => {
  assert.deepEqual(splitWechatText("第一段\n\n第二段"), ["第一段", "第二段"]);
  const long = "🙂".repeat(3_801);
  const chunks = splitWechatText(long);
  assert.equal(chunks.length, 2);
  assert.equal(Array.from(chunks[0]).length, 3_800);
  assert.equal(Array.from(chunks[1]).length, 1);
});

test("WeChat approval prompts stay separate from tool delivery and accept a scoped reply", async () => {
  const root = await temporaryDirectory("suzu-wechat-permission-");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const approvalResponses = [];
  const deliveredToClaude = [];
  const outgoing = [];
  const chatSubscribers = new Set();
  let releaseConfirmation = null;
  let releaseInitialization = null;
  let releaseApprovalReplies = null;
  let updatesStarted = false;
  let updatesCount = 0;
  const confirmation = new Promise((resolve) => { releaseConfirmation = resolve; });
  const initialization = new Promise((resolve) => { releaseInitialization = resolve; });
  const approvalReplies = new Promise((resolve) => { releaseApprovalReplies = resolve; });
  let approvalPending = true;
  const chat = {
    sendToSession: async (value) => { deliveredToClaude.push(value); return { accepted: true }; },
    respondPermissionForSession: (value) => {
      if (!approvalPending) return { accepted: false, reason: "no-pending-permission" };
      approvalPending = false;
      approvalResponses.push(value);
      return { accepted: true, requestId: "permission-1", behavior: value.behavior, toolName: "Bash" };
    },
    steer: async () => ({ accepted: true }),
    stop: () => ({ accepted: true }),
    subscribe: (listener) => {
      chatSubscribers.add(listener);
      return () => chatSubscribers.delete(listener);
    },
  };
  const reader = {
    resolveContactSession: async (contactId) => ({ contactId, id: "permission-session", projectRoot, hasTranscript: true }),
    contactIdForSession: async ({ sessionId, projectRoot: eventProjectRoot }) => (
      sessionId === "permission-session" && eventProjectRoot === projectRoot ? "contact-permission" : ""
    ),
  };
  const fetchImpl = async (target, init = {}) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/get_bot_qrcode")) {
      return jsonResponse({ qrcode: "permission-qr", qrcode_img_content: "https://weixin.example/qr?permission" });
    }
    if (url.pathname.endsWith("/get_qrcode_status")) {
      await confirmation;
      return jsonResponse({
        status: "confirmed",
        bot_token: "permission-bot-token",
        ilink_bot_id: "permission-bot",
        ilink_user_id: "permission-owner",
      });
    }
    if (url.pathname.endsWith("/getupdates")) {
      updatesCount += 1;
      if (updatesCount > 2) {
        return new Promise((_resolve, reject) => {
          if (init.signal?.aborted) { reject(new Error("aborted")); return; }
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (updatesCount === 1) {
        updatesStarted = true;
        await initialization;
        return jsonResponse({
          get_updates_buf: "permission-initialization-cursor",
          msgs: [{
            from_user_id: "permission-owner",
            message_id: "permission-initialization",
            context_token: "permission-context",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "/suzu stop" } }],
          }],
        });
      }
      await approvalReplies;
      return jsonResponse({
        get_updates_buf: "permission-cursor",
        msgs: [
          {
            from_user_id: "permission-owner",
            message_id: "permission-allow",
            context_token: "permission-context",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "允许" } }],
          },
          {
            from_user_id: "permission-owner",
            message_id: "permission-none-left",
            context_token: "permission-context",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "拒绝" } }],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/sendmessage")) {
      outgoing.push(JSON.parse(init.body));
      return jsonResponse({ ret: 0 });
    }
    throw new Error(`Unexpected iLink route: ${url.pathname}`);
  };
  const service = createWeChatLinkService({ chat, dataRoot: root, fetchImpl, reader });

  assert.equal((await service.snapshot()).delivery.permissions, true);
  assert.equal((await service.snapshot()).delivery.tools, false);
  await service.begin({ contactId: "contact-permission" });
  releaseConfirmation();
  await waitFor(() => updatesStarted, "微信审批测试没有开始接收消息");
  releaseInitialization();
  await waitFor(() => outgoing.length === 1, "微信初始化消息没有建立可回传的上下文");
  for (const listener of chatSubscribers) listener({
    type: "permission",
    requestId: "permission-1",
    sessionId: "permission-session",
    projectRoot,
    toolName: "Bash",
    preview: '{"command":"git status"}',
  });
  await waitFor(() => outgoing.length === 2, "默认审批提示没有投递到微信");
  assert.match(outgoing[1].msg.item_list[0].text_item.text, /工具权限：Bash/u);
  assert.match(outgoing[1].msg.item_list[0].text_item.text, /git status/u);
  assert.match(outgoing[1].msg.item_list[0].text_item.text, /回复“允许”或“拒绝”/u);

  releaseApprovalReplies();
  await waitFor(() => approvalResponses.length === 1, "微信“允许”没有处理对应会话的审批");
  assert.deepEqual(approvalResponses, [{ behavior: "allow", sessionId: "permission-session", projectRoot }]);
  await waitFor(() => outgoing.length === 4, "微信审批处理结果没有回传");
  assert.equal(outgoing[2].msg.item_list[0].text_item.text, "已允许工具权限：Bash。");
  assert.equal(outgoing[3].msg.item_list[0].text_item.text, "当前没有等待确认的工具请求。");
  assert.deepEqual(deliveredToClaude, []);
  service.dispose();
});

test("WeChat links persist a contact scope and relay through its fixed Claude session", async () => {
  const root = await temporaryDirectory("suzu-wechat-link-");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const deliveredToClaude = [];
  const outgoing = [];
  const uploadRequests = [];
  const uploadedBodies = [];
  const chatSubscribers = new Set();
  let releaseConfirmation = null;
  const confirmation = new Promise((resolve) => { releaseConfirmation = resolve; });
  let getUpdates = 0;
  const chat = {
    sendToSession: async (value) => { deliveredToClaude.push(value); return { accepted: true }; },
    steer: async () => ({ accepted: true, message: "引导已送达。" }),
    stop: () => ({ accepted: true, stopped: false, message: "当前联系人没有正在执行的 Claude Code 任务。" }),
    subscribe: (listener) => {
      chatSubscribers.add(listener);
      return () => chatSubscribers.delete(listener);
    },
  };
  const reader = {
    resolveContactSession: async (contactId) => {
      assert.equal(contactId, "contact-suzu");
      return { contactId, id: "session-1", projectRoot, hasTranscript: true };
    },
    contactIdForSession: async ({ sessionId, projectRoot: eventProjectRoot }) => (
      sessionId === "session-1" && eventProjectRoot === projectRoot ? "contact-suzu" : ""
    ),
  };
  const fetchImpl = async (target, init = {}) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/get_bot_qrcode")) {
      return jsonResponse({ qrcode: "qr-key", qrcode_img_content: "https://weixin.example/qr?session=session-1" });
    }
    if (url.pathname.endsWith("/get_qrcode_status")) {
      await confirmation;
      return jsonResponse({
        status: "confirmed",
        bot_token: "bot-token-fixture",
        ilink_bot_id: "bot-1",
        ilink_user_id: "owner-1",
      });
    }
    if (url.pathname.endsWith("/getupdates")) {
      getUpdates += 1;
      if (getUpdates === 1) {
        return jsonResponse({
          get_updates_buf: "cursor-1",
          msgs: [{
            from_user_id: "owner-1",
            message_id: "message-1",
            context_token: "context-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "从微信发来的文字" } }],
          }],
        });
      }
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) { reject(new Error("aborted")); return; }
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (url.pathname.endsWith("/getuploadurl")) {
      uploadRequests.push(JSON.parse(init.body));
      return jsonResponse({ ret: 0, upload_full_url: "https://cdn.weixin.example/upload-media" });
    }
    if (url.hostname === "cdn.weixin.example") {
      uploadedBodies.push(Buffer.from(init.body));
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => String(name).toLowerCase() === "x-encrypted-param" ? "encrypted-media-param" : null },
        text: async () => "",
      };
    }
    if (url.pathname.endsWith("/sendmessage")) {
      outgoing.push(JSON.parse(init.body));
      return jsonResponse({ ret: 0 });
    }
    throw new Error(`Unexpected iLink route: ${url.pathname}`);
  };
  const service = createWeChatLinkService({ chat, dataRoot: root, fetchImpl, reader });

  assert.equal((await service.snapshot()).enabled, true);
  const pending = await service.begin({ contactId: "contact-suzu" });
  assert.match(pending.pendingQr?.imageDataUrl || "", /^data:image\/png;base64,/u);
  releaseConfirmation();
  await waitFor(() => deliveredToClaude.length === 1, "微信入站消息没有进入 Claude 会话队列");
  assert.deepEqual(deliveredToClaude[0], {
    content: "从微信发来的文字",
    sessionId: "session-1",
    projectRoot,
    hasTranscript: true,
    kind: "message",
  });

  for (const listener of chatSubscribers) listener({
    type: "agent-reply",
    requestId: "reply-1",
    sessionId: "session-1",
    projectRoot,
    content: "工具前的说明\n\n分开的一段",
  });
  await waitFor(() => outgoing.length === 2, "Claude 回复没有按段发回微信");
  assert.deepEqual(outgoing.map((item) => item.msg.item_list[0].text_item.text), ["工具前的说明", "分开的一段"]);
  assert.ok(outgoing.every((item) => item.msg.context_token === "context-1"));

  await service.saveSettings({ delivery: { system: true } });
  for (const listener of chatSubscribers) listener({
    type: "error",
    kind: "schedule",
    requestId: "schedule-error",
    sessionId: "session-1",
    projectRoot,
    message: "定时器内部状态",
  });
  await flush();
  assert.equal(outgoing.length, 2);
  for (const listener of chatSubscribers) listener({
    type: "agent-reply",
    kind: "schedule",
    requestId: "schedule-reply",
    sessionId: "session-1",
    projectRoot,
    content: "这是定时任务真正要告诉你的内容",
  });
  await waitFor(() => outgoing.length === 3, "定时任务的最终 Agent 回复没有发回微信");
  assert.equal(outgoing[2].msg.item_list[0].text_item.text, "这是定时任务真正要告诉你的内容");

  const agentFile = path.join(root, "agent-report.txt");
  const agentImage = path.join(root, "agent-image.png");
  const agentAudio = path.join(root, "agent-voice.mp3");
  await fs.writeFile(agentFile, "文件内容");
  await fs.writeFile(agentImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(agentAudio, "MP3 内容");
  for (const listener of chatSubscribers) listener({
    type: "agent-media",
    requestId: "media-1",
    sessionId: "session-1",
    projectRoot,
    media: [
      { kind: "file", path: agentFile },
      { kind: "image", path: agentImage },
      { kind: "audio", path: agentAudio },
    ],
  });
  await waitFor(() => outgoing.length === 6, "Agent 文件没有自动投递到该会话绑定的微信");
  assert.deepEqual(uploadRequests.map((item) => item.media_type), [3, 1, 3]);
  assert.equal(uploadedBodies.length, 3);
  assert.ok(uploadedBodies.every((body) => body.length > 0));
  assert.equal(outgoing[3].msg.item_list[0].type, 4);
  assert.equal(outgoing[3].msg.item_list[0].file_item.file_name, "agent-report.txt");
  assert.equal(outgoing[4].msg.item_list[0].type, 2);
  assert.equal(outgoing[4].msg.item_list[0].image_item.media.encrypt_query_param, "encrypted-media-param");
  assert.equal(outgoing[5].msg.item_list[0].type, 4);
  assert.equal(outgoing[5].msg.item_list[0].file_item.file_name, "agent-voice.mp3");

  const credentialFile = await fs.readFile(path.join(root, "wechat-link", "credentials.json"), "utf8");
  assert.match(credentialFile, /bot-token-fixture/);
  const links = JSON.parse(await fs.readFile(path.join(root, "wechat-link", "connections.json"), "utf8"));
  assert.equal(links.links[0].contactId, "contact-suzu");
  assert.equal(Object.hasOwn(links.links[0], "sessionId"), false);
  assert.equal(Object.hasOwn(links.links[0], "projectRoot"), false);
  const removed = await service.removeContact({ contactId: "contact-suzu" });
  assert.equal(removed.removed, 1);
  const remainingLinks = JSON.parse(await fs.readFile(path.join(root, "wechat-link", "connections.json"), "utf8"));
  const remainingCredentials = await fs.readFile(path.join(root, "wechat-link", "credentials.json"), "utf8");
  assert.deepEqual(remainingLinks.links, []);
  assert.doesNotMatch(remainingCredentials, /bot-token-fixture/u);
  service.dispose();
});

test("WeChat images and files enter the bound Claude session while only supplied voice text is kept", async () => {
  const root = await temporaryDirectory("suzu-wechat-inbound-media-");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const deliveredToClaude = [];
  const chatSubscribers = new Set();
  const downloads = [];
  const mediaKey = Buffer.from("1234567890abcdef", "utf8");
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = Buffer.from("微信文件内容", "utf8");
  let releaseConfirmation = null;
  const confirmation = new Promise((resolve) => { releaseConfirmation = resolve; });
  let getUpdates = 0;
  const chat = {
    sendToSession: async (value) => { deliveredToClaude.push(value); return { accepted: true }; },
    steer: async () => ({ accepted: true }),
    stop: () => ({ accepted: true }),
    subscribe: (listener) => {
      chatSubscribers.add(listener);
      return () => chatSubscribers.delete(listener);
    },
  };
  const fetchImpl = async (target, init = {}) => {
    const url = new URL(String(target));
    if (url.pathname.endsWith("/get_bot_qrcode")) {
      return jsonResponse({ qrcode: "qr-key", qrcode_img_content: "https://weixin.example/qr?session=media" });
    }
    if (url.pathname.endsWith("/get_qrcode_status")) {
      await confirmation;
      return jsonResponse({
        status: "confirmed",
        bot_token: "bot-token-fixture",
        ilink_bot_id: "bot-1",
        ilink_user_id: "owner-1",
      });
    }
    if (url.pathname.endsWith("/getupdates")) {
      getUpdates += 1;
      if (getUpdates === 1) {
        return jsonResponse({
          get_updates_buf: "cursor-1",
          msgs: [{
            from_user_id: "owner-1",
            message_id: "message-media-1",
            context_token: "context-1",
            message_type: 1,
            item_list: [
              { type: 2, image_item: { aeskey: mediaKey.toString("hex"), media: { encrypt_query_param: "image-query" } } },
              { type: 4, file_item: { file_name: "微信文件.txt", media: { encrypt_query_param: "file-query", aes_key: Buffer.from(mediaKey.toString("hex"), "utf8").toString("base64") } } },
              { type: 3, voice_item: { text: "微信已经转写的语音" } },
              { type: 3, voice_item: { media: { encrypt_query_param: "raw-voice-query" } } },
            ],
          }],
        });
      }
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) { reject(new Error("aborted")); return; }
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (url.pathname.endsWith("/download")) {
      const query = url.searchParams.get("encrypted_query_param");
      downloads.push(query);
      if (query === "image-query") return binaryResponse(encryptAes128Ecb(image, mediaKey));
      if (query === "file-query") return binaryResponse(encryptAes128Ecb(file, mediaKey));
      throw new Error(`unexpected media download: ${query}`);
    }
    throw new Error(`Unexpected iLink route: ${url.pathname}`);
  };
  const service = createWeChatLinkService({
    chat,
    dataRoot: root,
    fetchImpl,
    reader: {
      resolveContactSession: async (contactId) => ({ contactId, id: "session-media", projectRoot, hasTranscript: true }),
      contactIdForSession: async ({ sessionId, projectRoot: eventProjectRoot }) => (
        sessionId === "session-media" && eventProjectRoot === projectRoot ? "contact-media" : ""
      ),
    },
  });

  await service.saveSettings({ enabled: true });
  const pending = await service.begin({ contactId: "contact-media" });
  assert.match(pending.pendingQr?.imageDataUrl || "", /^data:image\/png;base64,/u);
  releaseConfirmation();
  await waitFor(() => deliveredToClaude.length === 1, "微信媒体没有进入 Claude 会话队列");
  assert.equal(deliveredToClaude[0].content, "微信已经转写的语音");
  assert.equal(deliveredToClaude[0].media.length, 2);
  assert.deepEqual(downloads, ["image-query", "file-query"]);
  assert.equal(deliveredToClaude[0].media[0].kind, "image");
  assert.equal(deliveredToClaude[0].media[0].mimeType, "image/png");
  assert.equal(deliveredToClaude[0].media[1].fileName, "微信文件.txt");
  assert.equal(
    path.dirname(path.dirname(deliveredToClaude[0].media[0].path)),
    path.join(root, "agents", stableAgentId(projectRoot), "conversations", "session-media", "inbound"),
  );
  assert.deepEqual(await fs.readFile(deliveredToClaude[0].media[0].path), image);
  assert.deepEqual(await fs.readFile(deliveredToClaude[0].media[1].path), file);
  service.dispose();
});

test("an agent attachment without a matching WeChat link stays local and is not an Agent error", async () => {
  const root = await temporaryDirectory("suzu-wechat-unlinked-media-");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const chatSubscribers = new Set();
  let fetchCalls = 0;
  const service = createWeChatLinkService({
    chat: {
      sendToSession: async () => ({ accepted: true }),
      steer: async () => ({ accepted: true }),
      stop: () => ({ accepted: true }),
      subscribe: (listener) => {
        chatSubscribers.add(listener);
        return () => chatSubscribers.delete(listener);
      },
    },
    dataRoot: root,
    fetchImpl: async () => { fetchCalls += 1; throw new Error("unlinked media must not call WeChat"); },
    reader: {
      resolveContactSession: async (contactId) => ({ contactId, id: "session-unlinked", projectRoot, hasTranscript: true }),
      contactIdForSession: async () => "",
    },
  });
  const emitted = [];
  service.subscribe((event) => emitted.push(event));
  await service.saveSettings({ enabled: true });
  for (const listener of chatSubscribers) listener({
    type: "agent-media",
    requestId: "media-unlinked",
    sessionId: "session-unlinked",
    projectRoot,
    media: [{ kind: "file", path: path.join(projectRoot, "already-local.txt"), size: 1 }],
  });
  await flush();
  assert.equal(fetchCalls, 0);
  assert.equal(emitted.some((event) => event.type === "error"), false);
  service.dispose();
});
