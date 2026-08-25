import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createQQLinkService,
  splitQqText,
} from "../electron/services/qq-link.mjs";

const TEST_TEMP_ROOT = "D:\\Temp\\suzu-lives-qq-link-tests";

async function temporaryDirectory(prefix) {
  await fs.mkdir(TEST_TEMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TEST_TEMP_ROOT, prefix));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function jsonResponse(value) {
  const body = JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    text: async () => body,
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  emit(type, ...args) {
    return this.handlers.get(type)?.(...args);
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", 1000);
  }
}

const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`),
  decryptString: (value) => value.toString("utf8").replace(/^sealed:/u, ""),
};

test("QQ C2C binds a contact, sends replies only back to QQ, and broadcasts proactive care", async () => {
  FakeWebSocket.instances.length = 0;
  const root = await temporaryDirectory("qq-c2c-");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const session = { id: "qq-session", projectRoot, hasTranscript: true };
  const sentToSession = [];
  const subscribers = new Set();
  const outgoing = [];
  const chat = {
    sendToSession: async (value) => { sentToSession.push(value); return { accepted: true }; },
    steer: async () => ({ accepted: true }),
    stop: () => ({ accepted: true }),
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  const reader = {
    resolveContactSession: async (contactId) => ({ ...session, contactId }),
    contactIdForSession: async ({ sessionId, projectRoot: eventProjectRoot }) => (
      sessionId === session.id && eventProjectRoot === projectRoot ? "contact-qq" : ""
    ),
  };
  const fetchImpl = async (target, init = {}) => {
    const url = new URL(String(target));
    if (url.pathname === "/app/getAppAccessToken") {
      assert.deepEqual(JSON.parse(init.body), { appId: "qq-app-1", clientSecret: "qq-secret-1" });
      return jsonResponse({ access_token: "qq-access-token", expires_in: 7200 });
    }
    if (url.pathname === "/gateway") {
      assert.equal(init.headers.Authorization, "QQBot qq-access-token");
      return jsonResponse({ url: "wss://gateway.qq.example/socket" });
    }
    if (url.pathname === "/v2/users/user-openid-1/messages") {
      outgoing.push(JSON.parse(init.body));
      return jsonResponse({ id: `message-${outgoing.length}`, timestamp: "2026-08-25T12:00:00+08:00" });
    }
    throw new Error(`unexpected QQ route: ${url.pathname}`);
  };
  const service = createQQLinkService({
    chat,
    dataRoot: root,
    fetchImpl,
    reader,
    safeStorage: protector,
    WebSocketImpl: FakeWebSocket,
  });

  const initially = await service.snapshot();
  assert.equal(initially.bot.configured, false);
  assert.equal(initially.delivery.proactive, true);
  await service.configure({ appId: "qq-app-1", clientSecret: "qq-secret-1" });
  assert.equal(FakeWebSocket.instances.length, 1);
  const gateway = FakeWebSocket.instances[0];
  gateway.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  await waitFor(() => gateway.sent.length === 1, "QQ Gateway 没有发送 Identify");
  assert.deepEqual(gateway.sent[0], {
    op: 2,
    d: {
      token: "QQBot qq-access-token",
      intents: 1 << 25,
      shard: [0, 1],
      properties: { $os: process.platform, $browser: "suzu-lives", $device: "suzu-lives" },
    },
  });
  gateway.emit("message", JSON.stringify({
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: "gateway-session" },
  }));
  await waitFor(async () => (await service.snapshot()).bot.status === "connected", "QQ Gateway 没有进入已连接状态");

  const pending = await service.begin({ contactId: "contact-qq" });
  assert.match(pending.pendingBinding?.code || "", /^SUZU-[A-F0-9]{10}$/u);
  assert.deepEqual(Object.keys(pending.pendingBinding).sort(), ["code", "expiresAt", "id"]);
  const code = pending.pendingBinding.code;
  gateway.emit("message", JSON.stringify({
    op: 0,
    s: 2,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "bind-message",
      author: { user_openid: "user-openid-1" },
      content: code,
      timestamp: "2026-08-25T12:00:00+08:00",
    },
  }));
  await waitFor(() => outgoing.length === 1, "绑定成功后没有确认消息");
  assert.equal(outgoing[0].msg_id, "bind-message");
  assert.equal(outgoing[0].msg_seq, 1);
  assert.match(outgoing[0].content, /已连接/u);

  gateway.emit("message", JSON.stringify({
    op: 0,
    s: 3,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "inbound-message",
      author: { user_openid: "user-openid-1" },
      content: "今天怎么样？",
      timestamp: "2026-08-25T12:01:00+08:00",
    },
  }));
  await waitFor(() => sentToSession.length === 1, "QQ 入站消息没有进入联系人的固定会话");
  const inbound = sentToSession[0];
  assert.equal(inbound.content, "今天怎么样？");
  assert.equal(inbound.deliveryRoute.channel, "qq");
  assert.equal(inbound.deliveryRoute.connectionId.length > 0, true);
  assert.equal(inbound.deliveryRoute.replyMessageId, "inbound-message");
  assert.equal(Object.hasOwn(inbound, "deliverToWechat"), false);

  for (const listener of subscribers) listener({
    type: "agent-reply",
    requestId: inbound.requestId,
    sessionId: session.id,
    projectRoot,
    kind: "message",
    content: "我在呢。",
    deliveryRoute: inbound.deliveryRoute,
  });
  await waitFor(() => outgoing.length === 2, "QQ 入站回复没有投递回 QQ");
  assert.equal(outgoing[1].content, "我在呢。");
  assert.equal(outgoing[1].msg_id, "inbound-message");
  assert.equal(outgoing[1].msg_seq, 1);

  for (const listener of subscribers) listener({
    type: "agent-reply",
    sessionId: session.id,
    projectRoot,
    kind: "message",
    content: "这条本地消息不能外发。",
  });
  await flush();
  assert.equal(outgoing.length, 2);

  for (const listener of subscribers) listener({
    type: "agent-reply",
    sessionId: session.id,
    projectRoot,
    kind: "schedule",
    scheduleSource: "proactive-contact",
    content: "今天想你了。",
    deliveryRoute: { mode: "proactive" },
  });
  await waitFor(() => outgoing.length === 3, "主动关心没有投递到 QQ");
  assert.equal(outgoing[2].content, "今天想你了。");
  assert.equal(Object.hasOwn(outgoing[2], "msg_id"), false);

  const disabledProactive = await service.saveSettings({
    delivery: { ...(await service.snapshot()).delivery, proactive: false },
  });
  assert.equal(disabledProactive.delivery.proactive, false);
  for (const listener of subscribers) listener({
    type: "agent-reply",
    sessionId: session.id,
    projectRoot,
    kind: "schedule",
    scheduleSource: "proactive-contact",
    content: "这条主动关心不应投递到 QQ。",
    deliveryRoute: { mode: "proactive" },
  });
  await flush();
  assert.equal(outgoing.length, 3, "关闭“主动关心”后不应向 QQ 投递主动联系");

  const publicStore = await fs.readFile(path.join(root, "qq-link", "connections.json"), "utf8");
  const credentialStore = await fs.readFile(path.join(root, "qq-link", "credentials.json"), "utf8");
  assert.equal(JSON.parse(publicStore).delivery.proactive, false);
  assert.doesNotMatch(publicStore, /qq-secret-1/u);
  assert.doesNotMatch(credentialStore, /qq-secret-1/u);
  assert.match(Buffer.from(JSON.parse(credentialStore).encryptedClientSecret, "base64").toString("utf8"), /^sealed:/u);
  service.dispose();
});

test("QQ text delivery preserves paragraph and sentence boundaries", () => {
  assert.deepEqual(splitQqText("第一段\n\n第二段"), ["第一段", "第二段"]);
  assert.deepEqual(splitQqText("第一句。第二句！第三句？", { textSegmentation: "sentence" }), ["第一句。", "第二句！", "第三句？"]);
  assert.deepEqual(splitQqText("价格是 3.14。下一句。", { textSegmentation: "sentence" }), ["价格是 3.14。", "下一句。"]);
});
