import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  SUZU_COMPANION_AGENT_PRESET,
  SUZU_COMPANION_PERMISSION_MODE,
  SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET,
  createSuzuAgentRuntime,
  ensureSuzuCompanionAgentPreset,
  ensureSuzuSoftwareAssistantAgentPreset,
} from "../electron/services/suzu-agent-runtime.mjs";
import {
  SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE,
  SUZU_GLOBAL_INSTRUCTIONS_FILE,
} from "../electron/services/suzu-instruction-bridge.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-agent-runtime-"));
}

function createFakeRuntimeParts() {
  const calls = {
    cancelTurn: [],
    closeRuntime: 0,
    compact: [],
    createSession: [],
    createDriver: 0,
    createRuntimeFacade: 0,
    prompt: [],
    requestLifecycleCommand: [],
    resolveApproval: [],
    sendTurn: [],
    start: 0,
    stop: 0,
    subscribe: 0,
    subscribeLifecycle: 0,
    respondLifecycleRequest: [],
    supervisorOptions: [],
  };
  const lifecycleListeners = new Set();
  const facadeListeners = new Set();
  let sendTurnHandler = null;
  let compactHandler = null;
  let state = "stopped";
  const api = {
    sessions: {
      async history(value) {
        return { result: { ok: true, value: { events: [{ seq: 1, type: "user/message" }], requested: value } } };
      },
      async prompt(value) {
        calls.prompt.push(value);
        return { result: { ok: true, value: { accepted: true, command: { kind: "success", text: "Compacted 2 history items." } } } };
      },
      async compact(value) {
        calls.compact.push(value);
        if (compactHandler) return compactHandler(value);
        return { result: { ok: true, value: { accepted: true, completed: true, compactionId: "compact-2" } } };
      },
    },
  };
  const supervisor = {
    async start() {
      calls.start += 1;
      state = "ready";
      return { api, endpoint: "http://127.0.0.1:63123", pid: 12345 };
    },
    async stop() {
      calls.stop += 1;
      state = "stopped";
      return this.status();
    },
    status() {
      return { endpoint: state === "ready" ? "http://127.0.0.1:63123" : "", pid: state === "ready" ? 12345 : null, state };
    },
    subscribeLifecycle(listener) {
      calls.subscribeLifecycle += 1;
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    respondLifecycleRequest(value) {
      calls.respondLifecycleRequest.push(value);
      return true;
    },
    requestLifecycleCommand(value) {
      calls.requestLifecycleCommand.push(value);
      return {
        available: true,
        result: { ok: true, output: { memories: [] } },
      };
    },
  };
  const facade = {
    async cancelTurn(value) { calls.cancelTurn.push(value); return { accepted: true }; },
    async closeRuntime() { calls.closeRuntime += 1; },
    async createSession(value) { calls.createSession.push(value); return { created: true, runtimeSessionId: value.sessionId, sessionId: value.sessionId }; },
    async resolveApproval(value) { calls.resolveApproval.push(value); return { accepted: true }; },
    async sendTurn(value) {
      calls.sendTurn.push(value);
      await sendTurnHandler?.(value);
      return { accepted: true, turnId: value.turnId };
    },
    subscribe(listener) {
      calls.subscribe += 1;
      facadeListeners.add(listener);
      return () => facadeListeners.delete(listener);
    },
  };
  return {
    api,
    calls,
    createDriver: ({ api: receivedApi }) => {
      calls.createDriver += 1;
      assert.equal(receivedApi, api);
      return { name: "fake-driver" };
    },
    createRuntimeFacade: ({ driver }) => {
      calls.createRuntimeFacade += 1;
      assert.deepEqual(driver, { name: "fake-driver" });
      return facade;
    },
    createSupervisor: (options) => {
      calls.supervisorOptions.push(options);
      return supervisor;
    },
    emitLifecycle(message) {
      for (const listener of lifecycleListeners) listener(message);
    },
    emitRuntime(event) {
      for (const listener of facadeListeners) listener(event);
    },
    onSendTurn(handler) {
      sendTurnHandler = handler;
    },
    onCompact(handler) {
      compactHandler = handler;
    },
  };
}

test("Suzu Agent Runtime owns one shared process and routes public session/history calls", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const workspaceDirectory = path.join(root, "workspace");
  const temporaryDirectory = path.join(root, "scratch");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  const fake = createFakeRuntimeParts();
  const runtime = createSuzuAgentRuntime({
    dataRoot,
    temporaryDirectory,
    workspaceDirectory,
    createDriver: fake.createDriver,
    createRuntimeFacade: fake.createRuntimeFacade,
    createSupervisor: fake.createSupervisor,
  });
  const lifecycleMessages = [];
  runtime.subscribe((event) => {
    if (event.type.startsWith("lifecycle-")) lifecycleMessages.push(event);
  });

  const session = await runtime.ensureSession({ sessionId: "contact-session", contactId: "contact-1", cwd: workspaceDirectory });
  assert.equal(session.created, true);
  assert.deepEqual(fake.calls.createSession, [{
    sessionId: "contact-session",
    contactId: "contact-1",
    cwd: workspaceDirectory,
    presentation: { agentPreset: SUZU_COMPANION_AGENT_PRESET },
  }]);
  const softwareAssistantWorkspace = path.join(dataRoot, "software-assistant", "workspace");
  await fs.mkdir(softwareAssistantWorkspace, { recursive: true });
  const softwareAssistantSession = await runtime.ensureSession({
    sessionId: "suzu-software-assistant",
    cwd: softwareAssistantWorkspace,
    presentation: { agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET },
  });
  assert.equal(softwareAssistantSession.created, true);
  assert.deepEqual(fake.calls.createSession.at(-1), {
    sessionId: "suzu-software-assistant",
    contactId: "",
    cwd: softwareAssistantWorkspace,
    presentation: { agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET },
  });
  await assert.rejects(
    runtime.ensureSession({ sessionId: "unknown-preset", cwd: workspaceDirectory, presentation: { agentPreset: "third-party" } }),
    (error) => error?.code === "AGENT_PRESET_UNAVAILABLE",
  );
  fake.emitLifecycle({
    kind: "request",
    requestId: "context-1",
    event: "ContextCollect",
    payload: { sessionId: "contact-session", coreTurn: 1, step: 1 },
  });
  assert.deepEqual(lifecycleMessages, [{
    type: "lifecycle-request",
    requestId: "context-1",
    lifecycleEvent: "ContextCollect",
    data: { sessionId: "contact-session", coreTurn: 1, step: 1 },
  }]);
  assert.equal(await runtime.respondLifecycleRequest({ requestId: "context-1", result: { blocks: [] } }), true);
  assert.deepEqual(fake.calls.respondLifecycleRequest, [{ requestId: "context-1", result: { blocks: [] } }]);
  await runtime.sendTurn({ sessionId: "contact-session", turnId: "turn-1", input: "你好", placement: "queue" });
  await runtime.cancelTurn({ sessionId: "contact-session", turnId: "turn-1" });
  await runtime.resolveApproval({ sessionId: "contact-session", approvalId: "approval-1", decision: "allowed-once" });
  const history = await runtime.history({ sessionId: "contact-session", contactId: "contact-1", cwd: workspaceDirectory, maxMessages: 9999 });
  const compaction = await runtime.runCompaction({ sessionId: "contact-session", contactId: "contact-1", cwd: workspaceDirectory });

  assert.equal(fake.calls.createDriver, 1);
  assert.equal(fake.calls.createRuntimeFacade, 1);
  assert.equal(fake.calls.start, 3, "manual compaction obtains the native Core maintenance endpoint");
  assert.deepEqual(fake.calls.sendTurn[0], { sessionId: "contact-session", turnId: "turn-1", input: "你好", placement: "queue" });
  assert.equal(fake.calls.sendTurn.length, 1, "manual compaction must never create an ordinary chat turn");
  assert.deepEqual(fake.calls.cancelTurn, [{ sessionId: "contact-session", turnId: "turn-1" }]);
  assert.deepEqual(fake.calls.resolveApproval, [{ sessionId: "contact-session", approvalId: "approval-1", decision: "allowed-once" }]);
  assert.deepEqual(fake.calls.prompt, [], "manual compaction must not send /compact through sessions.prompt");
  assert.deepEqual(fake.calls.compact, [{ sessionId: "contact-session" }]);
  assert.deepEqual(compaction, { accepted: true, completed: true, compactionId: "compact-2" });
  assert.equal(history.events.length, 1);
  assert.deepEqual(history.events, [{ event: { seq: 1, type: "user/message" } }]);
  assert.equal(history.requested.maxMessages, 2_000);
  assert.equal(runtime.status().runtimeHome, path.join(dataRoot, "agent-runtime", "core"));
  assert.equal(runtime.status().temporaryDirectory, temporaryDirectory);
  assert.equal(runtime.status().coreProcessHome, path.join(dataRoot, "agent-runtime", "core-process-home"));
  assert.equal(runtime.status().coreAgentsHome, path.join(dataRoot, "agent-runtime", "core-agents"));
  assert.equal(runtime.status().coreAppData, path.join(dataRoot, "agent-runtime", "core-process-home", "AppData", "Roaming"));
  assert.equal(runtime.status().coreLocalAppData, path.join(dataRoot, "agent-runtime", "core-process-home", "AppData", "Local"));
  assert.equal(runtime.status().agentPreset, SUZU_COMPANION_AGENT_PRESET);
  assert.equal(runtime.status().softwareAssistantPreset, SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET);
  assert.equal(runtime.status().agentKey, "suzu");
  assert.equal(runtime.status().permissionMode, SUZU_COMPANION_PERMISSION_MODE);
  assert.equal(runtime.status().globalInstructionsPath, path.join(dataRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE));
  assert.equal(runtime.status().instructionBridgePath, path.join(dataRoot, "agent-runtime", "core", SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE));
  assert.deepEqual(fake.calls.supervisorOptions[0].environment, {
    SUZU_AGENT_AGENTS_HOME: path.join(dataRoot, "agent-runtime", "core-agents"),
    HOME: path.join(dataRoot, "agent-runtime", "core-process-home"),
    USERPROFILE: path.join(dataRoot, "agent-runtime", "core-process-home"),
    APPDATA: path.join(dataRoot, "agent-runtime", "core-process-home", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dataRoot, "agent-runtime", "core-process-home", "AppData", "Local"),
    SUZU_AGENT_PERMISSION_MODE: "danger-full-access",
    SUZU_AGENT_TELEMETRY_DISABLED: "1",
  });
  assert.deepEqual(fake.calls.supervisorOptions[0].patchFiles, [path.join(dataRoot, "agent-runtime", "core", "suzu-external-capabilities.cordis.patch.yml")]);
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core")));
  await assert.doesNotReject(fs.stat(temporaryDirectory));
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core-process-home")));
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core-agents")));
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core-process-home", "AppData", "Roaming")));
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core-process-home", "AppData", "Local")));
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", SUZU_COMPANION_AGENT_PRESET, "agent.cordis.yml")));
  await assert.doesNotReject(fs.stat(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET, "agent.cordis.yml")));
  const globalInstructions = await fs.readFile(path.join(dataRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE), "utf8");
  assert.equal(await fs.readFile(path.join(dataRoot, "agent-runtime", "core", SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE), "utf8"), globalInstructions);
  const preset = await fs.readFile(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", SUZU_COMPANION_AGENT_PRESET, "agent.cordis.yml"), "utf8");
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/core\/agent-instructions/u);
  assert.match(preset, /- SUZU\.md/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/core\/terminal-pwsh/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/core\/filesystem/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/core\/skill-filesystem/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/core\/skill-tool/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/capability-bridge/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/structured-generator/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/companion-compaction/u);
  assert.match(preset, /@suzu-lives\/suzu-agent-runtime\/core\/command-compact/u);
  assert.match(preset, /SUZU\.md instruction hierarchy is the source of truth/u);
  assert.doesNotMatch(preset, /You are Suzu/u);
  assert.doesNotMatch(preset, /do not merely mention its local path/u);
  assert.doesNotMatch(preset, /chat-attachment delivery/u);
  const softwareAssistantPreset = await fs.readFile(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET, "agent.cordis.yml"), "utf8");
  assert.match(softwareAssistantPreset, /software-assistant-bridge/u);
  assert.match(softwareAssistantPreset, /suzu-software-assistant-compaction/u);
  assert.doesNotMatch(softwareAssistantPreset, /agent-instructions/u);
  assert.match(softwareAssistantPreset, /core\/terminal-pwsh/u);
  assert.match(softwareAssistantPreset, /core\/filesystem/u);
  assert.match(softwareAssistantPreset, /core\/filesystem-search/u);
  assert.doesNotMatch(softwareAssistantPreset, /capability-bridge/u);
  assert.doesNotMatch(softwareAssistantPreset, /structured-generator/u);
  assert.doesNotMatch(preset, /forwards the successful attachment delivery/u);

  await runtime.close();
  assert.equal(fake.calls.closeRuntime, 1);
  assert.equal(fake.calls.stop, 1);
  await assert.rejects(runtime.ensureSession({ sessionId: "contact-session", cwd: workspaceDirectory }), (error) => error?.code === "RUNTIME_CLOSED");
});

test("Suzu Agent Runtime reports native compaction's no-history result without creating a chat turn", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const workspaceDirectory = path.join(root, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  const fake = createFakeRuntimeParts();
  const runtime = createSuzuAgentRuntime({
    dataRoot,
    workspaceDirectory,
    createDriver: fake.createDriver,
    createRuntimeFacade: fake.createRuntimeFacade,
    createSupervisor: fake.createSupervisor,
  });
  fake.onCompact(async () => ({
    result: { ok: true, value: { accepted: true, completed: false, reason: "NO_COMPACTABLE_HISTORY" } },
  }));

  const result = await runtime.runCompaction({
    sessionId: "contact-session",
    contactId: "contact-1",
    cwd: workspaceDirectory,
  });

  assert.deepEqual(result, {
    accepted: true,
    completed: false,
    reason: "NO_COMPACTABLE_HISTORY",
  });
  assert.equal(fake.calls.sendTurn.length, 0);
  assert.deepEqual(fake.calls.compact, [{ sessionId: "contact-session" }]);
  await runtime.close();
});

test("Suzu Agent Runtime returns the native compaction failure instead of a success notice", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const workspaceDirectory = path.join(root, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  const fake = createFakeRuntimeParts();
  const runtime = createSuzuAgentRuntime({
    dataRoot,
    workspaceDirectory,
    createDriver: fake.createDriver,
    createRuntimeFacade: fake.createRuntimeFacade,
    createSupervisor: fake.createSupervisor,
  });
  fake.onCompact(async () => ({
    result: { ok: false, error: { code: "AGENT_COMPACTION_FAILED", message: "summary request was rejected" } },
  }));

  await assert.rejects(
    runtime.runCompaction({
      sessionId: "contact-session",
      contactId: "contact-1",
      cwd: workspaceDirectory,
    }),
    (error) => error?.code === "AGENT_COMPACTION_FAILED" && /summary request was rejected/u.test(error.message),
  );
  await runtime.close();
});

test("Agent Core runtime falls back from the default D temp directory when a sandbox has no D volume", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const workspaceDirectory = path.join(root, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  const defaultTemporaryDirectory = path.join("D:\\Temp", "suzu-lives-agent-core");
  const fsOps = Object.create(fs);
  fsOps.mkdir = async (directory, options) => {
    if (directory === defaultTemporaryDirectory) {
      const error = new Error("D: volume is unavailable");
      error.code = "ENOENT";
      throw error;
    }
    return fs.mkdir(directory, options);
  };
  const fake = createFakeRuntimeParts();
  const runtime = createSuzuAgentRuntime({
    dataRoot,
    workspaceDirectory,
    fsOps,
    createDriver: fake.createDriver,
    createRuntimeFacade: fake.createRuntimeFacade,
    createSupervisor: fake.createSupervisor,
  });

  await runtime.ensureSession({ sessionId: "sandbox-session", cwd: workspaceDirectory });
  const fallbackTemporaryDirectory = path.join(dataRoot, "temporary", "agent-core");
  assert.equal(runtime.status().temporaryDirectory, fallbackTemporaryDirectory);
  assert.equal(fake.calls.supervisorOptions[0].temporaryDirectory, fallbackTemporaryDirectory);
  await assert.doesNotReject(fs.stat(fallbackTemporaryDirectory));

  await runtime.close();
});

test("Suzu Agent Runtime stops its owned child before erasing one persisted contact session", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const workspaceDirectory = path.join(root, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  const fake = createFakeRuntimeParts();
  const storageCalls = [];
  const runtime = createSuzuAgentRuntime({
    dataRoot,
    workspaceDirectory,
    createDriver: fake.createDriver,
    createRuntimeFacade: fake.createRuntimeFacade,
    createSupervisor: fake.createSupervisor,
    async deleteSessionStorage(value) {
      storageCalls.push(value);
      return { sessionDirectoryRemoved: true };
    },
  });

  await runtime.ensureSession({ sessionId: "delete-session", cwd: workspaceDirectory });
  const result = await runtime.purgeSession({
    sessionId: "delete-session",
    cwd: workspaceDirectory,
    imageAttachmentIds: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    protectedImageAttachmentIds: [],
  });

  assert.deepEqual(result, { sessionDirectoryRemoved: true });
  assert.equal(fake.calls.closeRuntime, 1);
  assert.equal(fake.calls.stop, 1);
  assert.equal(runtime.status().state, "stopped");
  assert.equal(storageCalls.length, 1);
  assert.equal(storageCalls[0].runtimeHome, path.join(dataRoot, "agent-runtime", "core"));
  assert.equal(storageCalls[0].projectRoot, workspaceDirectory);
  assert.equal(storageCalls[0].sessionId, "delete-session");
  assert.deepEqual(storageCalls[0].imageAttachmentIds, ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);

  await runtime.ensureSession({ sessionId: "remaining-session", cwd: workspaceDirectory });
  assert.equal(fake.calls.createDriver, 2, "the next contact turn gets a fresh facade after deletion");
  await runtime.close();
});

test("Suzu Agent Runtime sends memory's schema work only to the owned child bridge", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const workspaceDirectory = path.join(root, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  const fake = createFakeRuntimeParts();
  const runtime = createSuzuAgentRuntime({
    dataRoot,
    workspaceDirectory,
    createDriver: fake.createDriver,
    createRuntimeFacade: fake.createRuntimeFacade,
    createSupervisor: fake.createSupervisor,
  });

  const result = await runtime.generateStructuredMemory({
    contactId: "contact-suzu",
    cwd: workspaceDirectory,
    sessionId: "memory-session",
    input: "用户说下周要去海边。",
    systemPrompt: "提取长期记忆。",
    schema: { type: "object" },
    schemaName: "long-term-memory-extraction-v1",
  });

  assert.deepEqual(result, {
    available: true,
    result: { ok: true, output: { memories: [] } },
  });
  assert.deepEqual(fake.calls.createSession, [{
    sessionId: "memory-session",
    contactId: "contact-suzu",
    cwd: workspaceDirectory,
    presentation: { agentPreset: SUZU_COMPANION_AGENT_PRESET },
  }]);
  assert.deepEqual(fake.calls.requestLifecycleCommand, [{
    event: "StructuredGenerate",
    payload: {
      sessionId: "memory-session",
      input: "用户说下周要去海边。",
      systemPrompt: "提取长期记忆。",
      schema: { type: "object" },
      schemaName: "long-term-memory-extraction-v1",
    },
  }]);
  await runtime.close();
});

test("Suzu companion preset seeds missing files but never overwrites a local agent composition", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "runtime-home");
  const first = await ensureSuzuCompanionAgentPreset({ runtimeHome });
  assert.equal(first.agentPreset, SUZU_COMPANION_AGENT_PRESET);
  assert.equal(first.created, true);
  const target = path.join(first.directory, "agent.cordis.yml");
  await fs.writeFile(target, "name: 用户自定义陪伴模式\n", "utf8");
  const second = await ensureSuzuCompanionAgentPreset({ runtimeHome });
  assert.equal(second.created, false);
  assert.equal(second.updated, false);
  assert.equal(await fs.readFile(target, "utf8"), "name: 用户自定义陪伴模式\n");
});

test("Suzu software assistant preset is refreshed as a fixed product composition", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "runtime-home");
  const first = await ensureSuzuSoftwareAssistantAgentPreset({ runtimeHome });
  assert.equal(first.agentPreset, SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET);
  assert.equal(first.created, true);
  const target = path.join(first.directory, "agent.cordis.yml");
  await fs.writeFile(target, "name: stale software helper\n", "utf8");

  const refreshed = await ensureSuzuSoftwareAssistantAgentPreset({ runtimeHome });
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.updated, true);
  const preset = await fs.readFile(target, "utf8");
  assert.match(preset, /software-assistant-bridge/u);
  assert.match(preset, /core\/filesystem-search/u);
  assert.doesNotMatch(preset, /agent-instructions/u);
});
