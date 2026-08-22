import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createSuzuAgentLifecycleBridge,
  createSuzuAgentLifecycleBridgeTransport,
} from "../src/lifecycle-bridge.mjs";
import { SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL } from "../src/lifecycle-ipc.mjs";

function createParentChannel(onRequest) {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.pid = 55221;
  processRef.send = (message) => {
    if (message.kind === "request") {
      queueMicrotask(() => processRef.emit("message", {
        protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
        kind: "response",
        requestId: message.requestId,
        result: onRequest(message),
      }));
    }
    return true;
  };
  return processRef;
}

function createContext() {
  const listeners = new Map();
  return {
    listeners,
    on(event, callback, options) {
      listeners.set(event, { callback, options });
      return () => listeners.delete(event);
    },
  };
}

function createPublishingSession(ctx) {
  const events = [];
  const surfaceNodes = [];
  let publishing = false;
  const session = {
    id: "dynamic-task-session",
    events,
    surface: { nodes: surfaceNodes },
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    append(type, data, options = {}) {
      assert.equal(publishing, false, "cleanup must run after the observed session append");
      const event = {
        type,
        seq: events.length,
        time: events.length,
        data,
        ...(options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
      };
      if (options.surfaceOp === "append") {
        surfaceNodes.push(event.seq);
      } else if (options.surfaceOp?.op === "replace") {
        const start = surfaceNodes.indexOf(options.surfaceOp.start);
        const end = surfaceNodes.indexOf(options.surfaceOp.end);
        assert.ok(start >= 0 && end >= start, "cleanup must replace an active surface range");
        surfaceNodes.splice(start, end - start + 1, event.seq);
      }
      events.push(event);
      publishing = true;
      try {
        ctx.listeners.get("session/event")?.callback(session, event);
      } finally {
        publishing = false;
      }
      return event;
    },
  };
  return { events, session, surfaceNodes };
}

async function flushDeferredSessionWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("bridge tracks a dynamic task after Core has removed its empty trigger", async () => {
  const channel = createParentChannel((request) => {
    if (request.event === "ContextCollect") return { blocks: [] };
    if (request.event === "DynamicContextCollect") {
      return {
        blocks: [{
          id: "automation-task:check",
          kind: "automation-task",
          text: "判断是否主动关心。",
          metadata: { outputPolicy: "external" },
        }],
      };
    }
    assert.fail(`unexpected bridge request: ${request.event}`);
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const bridge = createSuzuAgentLifecycleBridge({
    transport,
    createMessage: (input) => ({ ...input, id: "dynamic-task-message", role: "user" }),
  });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  const { events, session, surfaceNodes } = createPublishingSession(ctx);
  session.append("turn/start", { turn: 7 });
  session.append("step/start", { turn: 7, step: 1 });

  // This is the real Agent Core timing: it has already removed its empty
  // task-trigger by the time the lifecycle hook observes the message list.
  const outcome = await ctx.listeners.get("agent/pre-step").callback({
    agent: { id: session.id, session },
    turn: 7,
    step: 1,
    signal: { aborted: false },
  }, async () => ({ kind: "enter", messages: [] }));

  assert.equal(outcome.messages.length, 1);
  const dynamic = session.append("user/message", outcome.messages[0], { surfaceOp: "append" });
  const noReply = session.append("assistant/message", {
    turn: 7,
    step: 1,
    message: {
      id: "check-no-reply",
      role: "assistant",
      content: [
        { type: "reasoning", text: "无需主动联系。" },
        { type: "text", text: "NO_REPLY" },
      ],
      source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    },
  }, { surfaceOp: "append" });
  session.append("turn/end", { turn: 7, reason: { kind: "completed" } });
  await flushDeferredSessionWork();

  const cleanup = events.at(-1);
  assert.equal(cleanup.type, "user/message");
  assert.equal(cleanup.data.source.form, "task-cleanup");
  assert.deepEqual(cleanup.surfaceOp, { op: "replace", start: dynamic.seq, end: noReply.seq });
  assert.deepEqual(surfaceNodes, [cleanup.seq]);
  transport.dispose();
});
