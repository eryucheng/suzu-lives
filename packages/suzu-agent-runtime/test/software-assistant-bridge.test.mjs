import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuSoftwareAssistantBridge } from "../src/software-assistant-bridge.mjs";

function registeredBridge(transport, config = {}) {
  const registered = new Map();
  createSuzuSoftwareAssistantBridge({ transport }).apply({
    tools: {
      register(tool) { registered.set(tool.name, tool); },
    },
  }, config);
  return registered;
}

const EXECUTION = Object.freeze({
  agent: { session: { id: "suzu-software-assistant" } },
  callId: "call-1",
  rootCallId: "root-1",
});

test("software assistant bridge exposes only the product state, manual, and registered action tools", async () => {
  const requests = [];
  const tools = registeredBridge({
    async request(event, payload, options) {
      requests.push({ event, payload, options });
      if (event === "SoftwareAssistantStatus") return { available: true, result: { content: "当前外观：浅色主题。" } };
      if (event === "SoftwareAssistantManual") return { available: true, result: { content: "打开设置 → API 连接。" } };
      return { available: true, result: { status: "completed", content: "已切换为深色主题。", data: { theme: "dark" } } };
    },
  }, { timeoutMs: 2_000 });

  assert.deepEqual([...tools.keys()], ["suzu_software_status", "suzu_software_manual", "suzu_software_action"]);
  assert.match(tools.get("suzu_software_status").description, /读取当前 Suzu Lives 软件状态/u);
  assert.match(tools.get("suzu_software_manual").description, /读取当前 Suzu Lives 产品手册/u);
  assert.match(tools.get("suzu_software_action").description, /执行一项已登记的 Suzu Lives 软件动作/u);
  assert.deepEqual(await tools.get("suzu_software_status").execute({}, EXECUTION), { content: "当前外观：浅色主题。" });
  assert.deepEqual(await tools.get("suzu_software_manual").execute({ query: "配置语音" }, EXECUTION), { content: "打开设置 → API 连接。" });
  assert.deepEqual(await tools.get("suzu_software_action").execute({ action: "set-theme", input: { theme: "dark" } }, EXECUTION), {
    status: "completed",
    content: "已切换为深色主题。",
    data: { theme: "dark" },
  });
  assert.deepEqual(requests, [
    {
      event: "SoftwareAssistantStatus",
      payload: { sessionId: "suzu-software-assistant", callId: "call-1", rootCallId: "root-1" },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantManual",
      payload: { sessionId: "suzu-software-assistant", callId: "call-1", rootCallId: "root-1", query: "配置语音" },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantAction",
      payload: {
        sessionId: "suzu-software-assistant",
        callId: "call-1",
        rootCallId: "root-1",
        action: "set-theme",
        input: { theme: "dark" },
      },
      options: { timeoutMs: 2_000 },
    },
  ]);
});

test("software assistant bridge rejects malformed action IDs before they reach the Electron host", async () => {
  let requests = 0;
  const tools = registeredBridge({
    async request() {
      requests += 1;
      return { available: true, result: {} };
    },
  });

  const result = await tools.get("suzu_software_action").execute({
    action: "delete every file",
    input: {},
  }, EXECUTION);
  assert.deepEqual(result, {
    status: "invalid-request",
    content: "软件动作 ID 无效；请先读取 suzu_software_manual。",
    data: null,
  });
  assert.equal(requests, 0);
});

test("software assistant bridge reports an unavailable parent without inventing an action outcome", async () => {
  const tools = registeredBridge({
    async request() { return { available: false, result: null }; },
  });

  assert.deepEqual(await tools.get("suzu_software_action").execute({ action: "navigate", input: { destinationId: "settings" } }, EXECUTION), {
    status: "parent-unavailable",
    content: "Suzu Lives 软件操作桥当前不可用。",
    data: null,
  });
});
