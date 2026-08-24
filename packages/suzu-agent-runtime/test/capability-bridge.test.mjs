import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuCapabilityBridge } from "../src/capability-bridge.mjs";

test("Agent Core capability bridge exposes only the Skill-selected action executor", async () => {
  const registered = new Map();
  const requests = [];
  const bridge = createSuzuCapabilityBridge({
    transport: {
      async request(event, payload, options) {
        requests.push({ event, payload, options });
        return {
          available: true,
          result: {
            status: "completed",
            value: { entryId: "note-1", input: payload.input },
          },
        };
      },
    },
  });
  bridge.apply({
    tools: {
      register(tool) { registered.set(tool.name, tool); },
    },
  }, { timeoutMs: 2_000 });

  const action = registered.get("suzu_capability");
  assert.ok(action);
  assert.equal(registered.has("suzu_capability_catalog"), false);
  assert.match(action.description, /已加载的 Suzu 产品 Skill/u);
  const exec = {
    agent: { session: { id: "session-1" } },
    callId: "call-1",
    rootCallId: "root-1",
  };

  const execution = await action.execute({
    capabilityId: "daily-note",
    action: "create",
    input: { text: "今天很好。" },
  }, exec);
  assert.deepEqual(execution, {
    status: "completed",
    content: '{\n  "entryId": "note-1",\n  "input": {\n    "text": "今天很好。"\n  }\n}',
    data: { entryId: "note-1", input: { text: "今天很好。" } },
  });
  assert.deepEqual(requests, [
    {
      event: "CapabilityExecute",
      payload: {
        sessionId: "session-1",
        callId: "call-1",
        rootCallId: "root-1",
        capabilityId: "daily-note",
        action: "create",
        input: { text: "今天很好。" },
      },
      options: { timeoutMs: 2_000 },
    },
  ]);
});

test("Agent Core capability bridge rejects a made-up action before it reaches the parent", async () => {
  const registered = new Map();
  let requests = 0;
  createSuzuCapabilityBridge({
    transport: {
      async request() {
        requests += 1;
        return { available: true, result: {} };
      },
    },
  }).apply({ tools: { register(tool) { registered.set(tool.name, tool); } } });

  const result = await registered.get("suzu_capability").execute({
    capabilityId: "not valid",
    action: "run",
  }, { agent: { session: { id: "session-1" } } });
  assert.equal(result.status, "invalid-request");
  assert.equal(requests, 0);
});

test("Agent Core capability bridge keeps long-running product actions within the product timeout ceiling", async () => {
  const registered = new Map();
  const requests = [];
  createSuzuCapabilityBridge({
    transport: {
      async request(event, payload, options) {
        requests.push({ event, payload, options });
        return { available: true, result: { actions: [] } };
      },
    },
  }).apply({ tools: { register(tool) { registered.set(tool.name, tool); } } }, { timeoutMs: 7_200_000 });

  await registered.get("suzu_capability").execute({
    capabilityId: "daily-note",
    action: "create",
  }, { agent: { session: { id: "session-long" } } });
  assert.equal(requests[0].options.timeoutMs, 3_600_000);
});

test("Agent Core capability bridge preserves concrete host failures and distinguishes bridge delivery failures", async () => {
  const execution = { agent: { session: { id: "session-1" } } };
  const unavailableCases = [
    ["timeout", {
      status: "parent-timeout",
      content: "Suzu 产品能力桥等待桌面主进程响应超时；该能力没有返回执行结果。",
      data: { code: "CAPABILITY_BRIDGE_TIMEOUT", reason: "timeout" },
    }],
    ["unavailable", {
      status: "parent-unavailable",
      content: "Suzu 产品能力桥未连接到桌面主进程，无法执行该能力。",
      data: { code: "CAPABILITY_BRIDGE_DISCONNECTED", reason: "unavailable" },
    }],
    ["disposed", {
      status: "parent-disposed",
      content: "Suzu Agent Core 正在退出，产品能力请求已取消。",
      data: { code: "CAPABILITY_BRIDGE_DISPOSED", reason: "disposed" },
    }],
  ];

  for (const [reason, expected] of unavailableCases) {
    const registered = new Map();
    createSuzuCapabilityBridge({
      transport: { async request() { return { available: false, reason }; } },
    }).apply({ tools: { register(tool) { registered.set(tool.name, tool); } } });
    assert.deepEqual(await registered.get("suzu_capability").execute({
      capabilityId: "web-browser",
      action: "open",
    }, execution), expected);
  }

  const registered = new Map();
  createSuzuCapabilityBridge({
    transport: {
      async request() {
        return {
          available: true,
          result: {
            status: "failed",
            error: {
              code: "BROWSER_NOT_RUNNING",
              message: "专用浏览器尚未启动。",
            },
          },
        };
      },
    },
  }).apply({ tools: { register(tool) { registered.set(tool.name, tool); } } });
  assert.deepEqual(await registered.get("suzu_capability").execute({
    capabilityId: "web-browser",
    action: "open",
  }, execution), {
    status: "failed",
    content: "专用浏览器尚未启动。",
    data: {
      code: "BROWSER_NOT_RUNNING",
      message: "专用浏览器尚未启动。",
    },
  });

  const brokenTransport = new Error("IPC 通道已关闭。");
  brokenTransport.code = "ERR_IPC_CHANNEL_CLOSED";
  const brokenRegistered = new Map();
  createSuzuCapabilityBridge({
    transport: { async request() { throw brokenTransport; } },
  }).apply({ tools: { register(tool) { brokenRegistered.set(tool.name, tool); } } });
  assert.deepEqual(await brokenRegistered.get("suzu_capability").execute({
    capabilityId: "web-browser",
    action: "open",
  }, execution), {
    status: "parent-transport-error",
    content: "Suzu 产品能力桥通信失败：IPC 通道已关闭。",
    data: {
      code: "ERR_IPC_CHANNEL_CLOSED",
      message: "IPC 通道已关闭。",
    },
  });
});
