import assert from "node:assert/strict";
import test from "node:test";

import {
  CapabilityRegistryError,
  createCapabilityRegistry,
  createCapabilityRuntime,
  defineCapability,
} from "../electron/services/capability-registry.mjs";

test("capability registry is the single source for catalog, contact config cleanup, and resource declarations", () => {
  const registry = createCapabilityRegistry();
  assert.deepEqual(registry.catalog().map((entry) => entry.id), [
    "image-generation",
    "phone-camera",
    "time-awareness",
    "image-vision",
    "video-understanding",
    "voice-message",
    "web-browser",
    "mail-bridge",
    "agent-journal",
    "proactive-contact",
  ]);
  assert.deepEqual(registry.configPath("agent-journal"), ["automation", "agent-journal", "config.json"]);
  assert.equal(registry.isContactScoped("agent-journal"), true);
  assert.equal(registry.runtimeStatus("image-vision"), "agent-capability-bridge");
  assert.equal(registry.runtimeStatus("mail-bridge"), "agent-capability-bridge");
  assert.equal(registry.get("mail-bridge")?.category, "companion");
  assert.deepEqual(registry.configPath("web-browser"), ["capabilities", "web-browser", "config.json"]);
  assert.equal(registry.runtimeStatus("web-browser"), "agent-capability-bridge");
  assert.deepEqual(
    registry.resources("agent-journal").map(({ kind, id }) => ({ kind, id })),
    [
      { id: "daily-task", kind: "task" },
      { id: "scheduled-turn", kind: "agent-turn" },
      { id: "entries", kind: "storage" },
      { id: "usage-ledger", kind: "usage" },
    ],
  );
  const cleanup = registry.contactConfigEntries();
  assert.equal(cleanup.some((entry) => entry.path.join("/") === "automation/agent-journal/config.json"), true);
  assert.equal(cleanup.some((entry) => entry.path.join("/") === "automation/mail-bridge/config.json"), true);
  assert.equal(registry.catalog().some((entry) => entry.id === "memory-recall"), false);
  assert.equal(registry.catalog().some((entry) => entry.id === "conversation-attachment"), false);
  assert.equal(registry.get("traveling-merchant"), null);
  assert.deepEqual(registry.agentActions({ capabilityId: "conversation-attachment" }).map((action) => ({
    capabilityId: action.capabilityId,
    action: action.action,
    resourceId: action.resourceId,
  })), [{
    capabilityId: "conversation-attachment",
    action: "deliver",
    resourceId: "agent-delivery",
  }]);
  assert.deepEqual(registry.agentActions({ capabilityId: "image-generation" }).map((action) => ({
    capabilityId: action.capabilityId,
    action: action.action,
    resourceId: action.resourceId,
  })), [{
    capabilityId: "image-generation",
    action: "generate",
    resourceId: "agent-action",
  }]);
  assert.deepEqual(registry.agentActions({ capabilityId: "mail-bridge" }).map((action) => ({
    capabilityId: action.capabilityId,
    action: action.action,
    resourceId: action.resourceId,
  })), [{
    capabilityId: "mail-bridge",
    action: "send",
    resourceId: "agent-action",
  }]);
  const browserActions = registry.agentActions({ capabilityId: "web-browser" });
  assert.equal(browserActions.length, 16);
  assert.deepEqual(browserActions.filter((action) => ["open", "upload", "evaluate"].includes(action.action)).map((action) => action.action), ["open", "upload", "evaluate"]);
});

test("capability registry builds only declared dynamic Hook modules", () => {
  const registry = createCapabilityRegistry({
    hookFactories: {
      "automation-task-context": () => ({ collect: () => ({ id: "task", kind: "dynamic", text: "任务" }) }),
      "time-awareness": () => ({ collect: () => ({ id: "time", kind: "dynamic", text: "现在" }) }),
      "memory-recall": () => ({ collect: () => ({ id: "memory", kind: "dynamic", text: "记忆" }) }),
    },
  });
  assert.deepEqual(
    registry.createHookModules({ dataRoot: "D:\\Temp\\suzu-lives-capability-registry" }).map((module) => module.id),
    ["time-awareness", "automation-task-context"],
  );
  assert.deepEqual(
    registry.createHookModules({
      dataRoot: "D:\\Temp\\suzu-lives-capability-registry",
      memoryRuntime: { recallForTurn: async () => ({}) },
    }).map((module) => module.id),
    ["time-awareness", "memory-recall", "automation-task-context"],
  );
});

test("chat attachment delivery stays an on-demand capability action", () => {
  const registry = createCapabilityRegistry();
  assert.equal(
    registry.createHookModules({ dataRoot: "D:\\Temp\\suzu-lives-capability-registry" })
      .some((module) => module.id === "conversation-attachment-delivery"),
    false,
  );
  const [delivery] = registry.agentActions({ capabilityId: "conversation-attachment" });
  assert.equal(delivery.action, "deliver");
  assert.match(delivery.actionDescription, /当前聊天/u);
  assert.match(delivery.actionDescription, /自动转发/u);
});

test("automation task context is mounted as a one-turn dynamic Hook, not a contact instruction", async () => {
  const registry = createCapabilityRegistry();
  const hook = registry.createHookModules({ dataRoot: "D:\\Temp\\suzu-lives-capability-registry" })
    .find((module) => module.id === "automation-task-context");
  assert.equal(hook.lifecycleEvent, "DynamicContextCollect");
  assert.equal(await hook.handler({ sessionId: "session-a", turnId: "turn-a" }), null);
  const block = await hook.handler({
    sessionId: "session-a",
    turnId: "turn-a",
    scheduleSource: "proactive-chain-planning",
    outputPolicy: "silent",
    taskContext: { id: "schedule-a", text: "安排下一次主动关心。" },
  });
  assert.equal(block.kind, "automation-task");
  assert.equal(block.display.transcript, false);
  assert.equal(block.metadata.outputPolicy, "silent");
  assert.match(block.text, /不是用户发来的新消息/u);
});

test("capability registry rejects a malformed resource before it can create a stray integration", () => {
  assert.throws(
    () => defineCapability({
      id: "bad-capability",
      resources: [{ id: "unknown", kind: "something-new" }],
    }),
    (error) => error instanceof CapabilityRegistryError && error.code === "RESOURCE_KIND_UNKNOWN",
  );
  assert.throws(
    () => createCapabilityRegistry({
      definitions: [
        { id: "same", resources: [] },
        { id: "same", resources: [] },
      ],
    }),
    (error) => error instanceof CapabilityRegistryError && error.code === "DUPLICATE_CAPABILITY_ID",
  );
  assert.throws(
    () => createCapabilityRegistry({
      definitions: [
        { id: "first", config: { path: ["capabilities", "shared", "config.json"] }, resources: [] },
        { id: "second", config: { path: ["capabilities", "shared", "config.json"] }, resources: [] },
      ],
    }),
    (error) => error instanceof CapabilityRegistryError && error.code === "DUPLICATE_CONFIG_PATH",
  );
});

test("capability runtime routes sync and contact deletion through declared resource adapters", async () => {
  const registry = createCapabilityRegistry({
    definitions: [{
      id: "daily-note",
      name: "每日记录",
      description: "测试能力。",
      category: "test",
      config: {
        path: ["automation", "daily-note", "config.json"],
        contactScoped: true,
        contactFields: ["enabledContactIds"],
      },
      resources: [
        { id: "timer", kind: "task", driver: "daily-note-scheduler", lifecycle: ["sync"] },
        { id: "notes", kind: "storage", driver: "daily-note-storage", lifecycle: ["remove-contact"] },
        { id: "usage", kind: "usage", driver: "cost-ledger" },
      ],
    }],
  });
  const calls = [];
  const runtime = createCapabilityRuntime({
    registry,
    adapters: {
      "daily-note-scheduler": ({ context }) => {
        calls.push({ type: "sync", context });
        return "scheduled";
      },
      "daily-note-storage": ({ context }) => {
        calls.push({ type: "remove", context });
        return "removed";
      },
      "cost-ledger": ({ context }) => {
        calls.push({ type: "usage", context });
        return "recorded";
      },
    },
  });

  const synchronized = await runtime.sync({ capabilityId: "daily-note", reason: "settings-saved" });
  assert.deepEqual(synchronized.map(({ resourceId, status, value }) => ({ resourceId, status, value })), [
    { resourceId: "timer", status: "completed", value: "scheduled" },
  ]);
  const removed = await runtime.removeContact({ capabilityId: "daily-note", contactId: "contact-a" });
  assert.deepEqual(removed.map(({ resourceId, status, value }) => ({ resourceId, status, value })), [
    { resourceId: "notes", status: "completed", value: "removed" },
  ]);
  const usage = await runtime.recordUsage({
    capabilityId: "daily-note",
    ledgerPath: "D:/Temp/suzu-lives-capability-registry/usage.jsonl",
    event: { model: "deepseek-chat", feature: "daily-note" },
  });
  assert.deepEqual(usage.map(({ resourceId, status, value }) => ({ resourceId, status, value })), [
    { resourceId: "usage", status: "completed", value: "recorded" },
  ]);
  assert.deepEqual(calls, [
    { type: "sync", context: { reason: "settings-saved" } },
    { type: "remove", context: { contactId: "contact-a" } },
    {
      type: "usage",
      context: {
        ledgerPath: "D:/Temp/suzu-lives-capability-registry/usage.jsonl",
        event: { model: "deepseek-chat", feature: "daily-note" },
      },
    },
  ]);
});

test("capability registry exposes only adapter-connected agent actions through one invoke contract", async () => {
  const registry = createCapabilityRegistry({
    definitions: [{
      id: "daily-note",
      name: "每日记录",
      description: "测试模型调用的统一能力入口。",
      category: "test",
      resources: [{
        id: "note-cli",
        kind: "cli",
        driver: "daily-note-cli",
        lifecycle: ["invoke"],
        agentAction: {
          id: "create",
          name: "写入今日记录",
          description: "将用户确认的内容写入今日记录。",
        },
      }],
    }],
  });
  const calls = [];
  const runtime = createCapabilityRuntime({
    registry,
    adapters: {
      "daily-note-cli": ({ action, capability, context, lifecycle, resource }) => {
        calls.push({ action, capability: capability.id, context, lifecycle, resource: resource.id });
        return { entryId: "entry-1", text: context.input.text };
      },
    },
  });

  assert.deepEqual(runtime.availableActions(), [{
    capabilityId: "daily-note",
    capabilityName: "每日记录",
    capabilityDescription: "测试模型调用的统一能力入口。",
    resourceId: "note-cli",
    resourceKind: "cli",
    driver: "daily-note-cli",
    action: "create",
    actionDescription: "将用户确认的内容写入今日记录。",
    actionName: "写入今日记录",
  }]);
  const result = await runtime.invoke({
    capabilityId: "daily-note",
    action: "create",
    contactId: "contact-suzu",
    input: { text: "今天下雨了。" },
  });
  assert.deepEqual(result, {
    capabilityId: "daily-note",
    action: "create",
    resourceId: "note-cli",
    kind: "cli",
    status: "completed",
    value: { entryId: "entry-1", text: "今天下雨了。" },
  });
  assert.deepEqual(calls, [{
    action: {
      capabilityId: "daily-note",
      capabilityName: "每日记录",
      capabilityDescription: "测试模型调用的统一能力入口。",
      resourceId: "note-cli",
      resourceKind: "cli",
      driver: "daily-note-cli",
      action: "create",
      actionDescription: "将用户确认的内容写入今日记录。",
      actionName: "写入今日记录",
    },
    capability: "daily-note",
    context: { contactId: "contact-suzu", input: { text: "今天下雨了。" } },
    lifecycle: "invoke",
    resource: "note-cli",
  }]);

  const disconnected = createCapabilityRuntime({ registry });
  assert.deepEqual(disconnected.availableActions(), []);
  assert.equal((await disconnected.invoke({ capabilityId: "daily-note", action: "create" })).status, "adapter-not-connected");
});

test("capability registry rejects a model action without a declared invoke lifecycle", () => {
  assert.throws(
    () => defineCapability({
      id: "bad-action",
      resources: [{
        id: "runner",
        kind: "cli",
        agentAction: { id: "run", description: "运行。" },
      }],
    }),
    (error) => error instanceof CapabilityRegistryError && error.code === "AGENT_ACTION_INVOKE_REQUIRED",
  );
});
