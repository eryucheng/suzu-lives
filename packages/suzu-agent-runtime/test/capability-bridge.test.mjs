import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuCapabilityBridge } from "../src/capability-bridge.mjs";

test("Agent Core capability bridge exposes only parent-provided catalog actions and delegates execution", async () => {
  const registered = new Map();
  const requests = [];
  const bridge = createSuzuCapabilityBridge({
    transport: {
      async request(event, payload, options) {
        requests.push({ event, payload, options });
        if (event === "CapabilityCatalog") {
          return {
            available: true,
            result: {
              actions: [
                {
                  capabilityId: "daily-note",
                  capabilityName: "每日记录",
                  action: "create",
                  actionName: "写一条记录",
                  actionDescription: "把这次对话写入今日记录。",
                },
                { capabilityId: "invalid id", action: "ignored", actionDescription: "不能进入目录。" },
              ],
            },
          };
        }
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

  const catalog = registered.get("suzu_capability_catalog");
  const action = registered.get("suzu_capability");
  assert.ok(catalog);
  assert.ok(action);
  assert.match(catalog.description, /列出当前为此对话已连接的 Suzu 产品能力动作/u);
  assert.match(action.description, /执行一个由 suzu_capability_catalog 返回的 Suzu 产品能力动作/u);
  const exec = {
    agent: { session: { id: "session-1" } },
    callId: "call-1",
    rootCallId: "root-1",
  };

  const catalogResult = await catalog.execute({}, exec);
  assert.deepEqual(catalogResult, {
    actions: [{
      capabilityId: "daily-note",
      capabilityName: "每日记录",
      action: "create",
      actionName: "写一条记录",
      description: "把这次对话写入今日记录。",
    }],
  });
  assert.match(catalog.output.render({}, catalogResult)[0].text, /daily-note\.create/u);

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
      event: "CapabilityCatalog",
      payload: { sessionId: "session-1", callId: "call-1", rootCallId: "root-1" },
      options: { timeoutMs: 2_000 },
    },
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

  await registered.get("suzu_capability_catalog").execute({}, { agent: { session: { id: "session-long" } } });
  assert.equal(requests[0].options.timeoutMs, 3_600_000);
});
