import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolve as resolveEmbeddedModule } from "../src/embedded-module-loader.mjs";
import {
  SuzuAgentRuntimeError,
  createSuzuAgentCoreSupervisor,
  resolveEmbeddedSuzuAgentHost,
  resolveEmbeddedSuzuAgentModuleLoader,
} from "../src/index.mjs";
import { SUZU_AGENT_HOST_IPC_PROTOCOL } from "../src/agent-host-ipc.mjs";
import { SuzuAgentHost } from "../src/embedded-agent-host.mjs";
import { SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL } from "../src/lifecycle-ipc.mjs";
import { resolveSuzuAgentCoreNativeAnchor } from "../src/core-bundle.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));

function waitBriefly(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 2)));
}

async function awaitWithActiveHandle(promise) {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

function createFakeChild(pid = 55123) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => undefined;
  child.stderr.setEncoding = () => undefined;
  child.connected = true;
  child.kills = [];
  child.sent = [];
  child.send = (message) => {
    child.sent.push(message);
    if (message?.protocol === SUZU_AGENT_HOST_IPC_PROTOCOL && message?.kind === "request" && message?.method === "host.describe") {
      queueMicrotask(() => child.emit("message", {
        protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
        kind: "response",
        requestId: message.requestId,
        result: { ok: true, value: { runtime: "suzu-agent-core", transport: "node-ipc", version: "1" } },
      }));
    }
    return true;
  };
  child.kill = (signal) => {
    child.kills.push(signal || "default");
    queueMicrotask(() => child.emit("exit", 0, signal || null));
    return true;
  };
  return child;
}

const supervisors = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
});

function makeSupervisor({ ready = true, patchFiles = [], exitsImmediately = false, resourcesPath = "" } = {}) {
  const calls = { spawn: [] };
  const child = createFakeChild();
  const supervisor = createSuzuAgentCoreSupervisor({
    runtimeHome: process.cwd(),
    temporaryDirectory: process.cwd(),
    workspaceDirectory: process.cwd(),
    agentHost: process.execPath,
    nodeExecutable: process.execPath,
    spawnImpl(executable, args, options) {
      calls.spawn.push({ executable, args, options });
      if (ready) queueMicrotask(() => child.emit("message", {
        protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
        kind: "ready",
        details: { runtime: "suzu-agent-core", transport: "node-ipc" },
      }));
      if (exitsImmediately) queueMicrotask(() => {
        child.stderr.emit("data", "suzu-agent-core: Cannot find selected package 'missing-core-plugin'\n");
        child.emit("exit", 1, null);
      });
      return child;
    },
    wait: waitBriefly,
    startupTimeoutMs: ready ? 100 : 10,
    stopTimeoutMs: 25,
    patchFiles,
    resourcesPath,
  });
  supervisors.push(supervisor);
  return { supervisor, calls, child };
}

test("supervisor launches an owned Suzu IPC child with explicit data paths", async () => {
  const { supervisor, calls, child } = makeSupervisor();
  const events = [];
  supervisor.subscribe((event) => events.push(event.type));
  const running = await supervisor.start();

  assert.equal(running.endpoint, "");
  assert.equal(running.transport, "node-ipc");
  assert.equal(running.pid, child.pid);
  assert.equal(running.describe.runtime, "suzu-agent-core");
  assert.deepEqual(calls.spawn[0].args.slice(0, 2), ["--experimental-loader", pathToFileURL(resolveEmbeddedSuzuAgentModuleLoader()).href]);
  assert.equal(calls.spawn[0].args[2], process.execPath);
  assert.equal(calls.spawn[0].args.includes("web"), false);
  assert.equal(calls.spawn[0].args.includes("--host"), false);
  assert.equal(calls.spawn[0].args.includes("--port"), false);
  assert.equal(calls.spawn[0].options.windowsHide, true);
  assert.equal(calls.spawn[0].options.shell, false);
  assert.deepEqual(calls.spawn[0].options.stdio, ["ignore", "pipe", "pipe", "ipc"]);
  assert.equal(calls.spawn[0].options.env.SUZU_AGENT_HOME, process.cwd());
  assert.equal(calls.spawn[0].options.env.TEMP, process.cwd());
  assert.equal(calls.spawn[0].options.env.TMPDIR, process.cwd());
  assert.equal(calls.spawn[0].options.env.npm_config_cache, `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}npm-cache`);
  assert.deepEqual(events, ["starting", "ready"]);

  const stopped = await supervisor.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(child.kills.length >= 1, true);
  assert.equal(events.includes("stopped"), true);
});

test("supervisor exposes native session compaction as a long-running IPC request", async () => {
  const { supervisor, child } = makeSupervisor();
  const running = await supervisor.start();

  const pending = running.api.sessions.compact({ sessionId: "session-compact-1" });
  const request = child.sent.at(-1);
  assert.equal(request.method, "sessions.compact");
  assert.deepEqual(request.payload, { sessionId: "session-compact-1" });
  child.emit("message", {
    protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
    kind: "response",
    requestId: request.requestId,
    result: { ok: true, value: { accepted: true, completed: true, compactionId: "compact-1" } },
  });

  assert.deepEqual(await pending, {
    result: { ok: true, value: { accepted: true, completed: true, compactionId: "compact-1" } },
  });
});

test("supervisor passes the packaged native dependency island to its owned child", async () => {
  const resourcesPath = resolve(process.cwd(), "resources-for-test");
  const { supervisor, calls } = makeSupervisor({ resourcesPath });
  await supervisor.start();
  assert.equal(calls.spawn[0].options.env.SUZU_AGENT_CORE_NATIVE_ROOT, join(resourcesPath, "agent-core-native", "node_modules"));
});

test("native core resolver accepts the supervisor-provided runtime root", () => {
  const nativeRuntimeRoot = resolve(TEST_DIRECTORY, "..", "vendor", "core", "node_modules");
  assert.equal(
    resolveSuzuAgentCoreNativeAnchor({ nativeRuntimeRoot }),
    join(nativeRuntimeRoot, "@suzu-lives", "agent-core-native", "package.json"),
  );
});

test("supervisor forwards only validated lifecycle IPC and replies to the owned child", async () => {
  const { supervisor, child } = makeSupervisor();
  const messages = [];
  supervisor.subscribeLifecycle((message) => messages.push(message));
  await supervisor.start();

  child.emit("message", {
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "request",
    requestId: "context-1",
    event: "ContextCollect",
    payload: { sessionId: "session-1" },
  });
  child.emit("message", { protocol: "other", kind: "request", requestId: "ignored", event: "ContextCollect", payload: {} });

  assert.deepEqual(messages, [{
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "request",
    requestId: "context-1",
    event: "ContextCollect",
    payload: { sessionId: "session-1" },
  }]);
  assert.equal(supervisor.respondLifecycleRequest({ requestId: "context-1", result: { blocks: [] } }), true);
  assert.deepEqual(child.sent.at(-1), {
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "response",
    requestId: "context-1",
    result: { blocks: [] },
  });
});

test("supervisor resolves a parent-originated product command only from its owned child", async () => {
  const { supervisor, child } = makeSupervisor();
  const published = [];
  supervisor.subscribeLifecycle((message) => published.push(message));
  await supervisor.start();

  const pending = supervisor.requestLifecycleCommand({
    event: "StructuredGenerate",
    payload: { sessionId: "session-1", input: "{}" },
    timeoutMs: 1_000,
  });
  const command = child.sent.at(-1);
  assert.equal(command.kind, "command");
  assert.equal(command.event, "StructuredGenerate");
  child.emit("message", {
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "response",
    requestId: command.requestId,
    result: { ok: true, output: { memories: [] } },
  });

  assert.deepEqual(await pending, { available: true, result: { ok: true, output: { memories: [] } } });
  assert.deepEqual(published, []);
});

test("supervisor tears down its owned child after an IPC startup timeout", async () => {
  const { supervisor, child } = makeSupervisor({ ready: false });
  await assert.rejects(
    awaitWithActiveHandle(supervisor.start()),
    (error) => error instanceof SuzuAgentRuntimeError && error.code === "AGENT_CORE_START_TIMEOUT",
  );
  await waitBriefly(2);
  assert.equal(child.kills.length >= 1, true);
  assert.equal(supervisor.status().state, "stopped");
});

test("supervisor retains a concise Agent Core startup diagnostic when the child exits", async () => {
  const { supervisor } = makeSupervisor({ exitsImmediately: true });
  await assert.rejects(
    supervisor.start(),
    (error) => error instanceof SuzuAgentRuntimeError
      && error.code === "AGENT_CORE_EXITED"
      && /missing-core-plugin/u.test(error.message),
  );
});

test("supervisor forwards validated patch files to the IPC host", async () => {
  const { supervisor, calls } = makeSupervisor({ patchFiles: [process.execPath, process.execPath] });
  await supervisor.start();
  const args = calls.spawn[0].args;
  assert.deepEqual(args.slice(2), [process.execPath, "--patch", process.execPath]);
  assert.equal(args.filter((argument) => argument === "--patch").length, 1);
  assert.throws(
    () => createSuzuAgentCoreSupervisor({
      runtimeHome: process.cwd(),
      temporaryDirectory: process.cwd(),
      workspaceDirectory: process.cwd(),
      agentHost: process.execPath,
      nodeExecutable: process.execPath,
      patchFiles: ["D:\\missing-agent-core-patch.yml"],
    }),
    (error) => error instanceof SuzuAgentRuntimeError && error.code === "PATCH_FILE_NOT_FOUND",
  );
});

test("embedded host keeps a newly created session's contact workspace for its first prompt", async () => {
  const workspace = resolve(TEST_DIRECTORY, "host-contact-workspace");
  const followups = [];
  const compactions = [];
  const agents = new Map();
  const compaction = {
    async compactNow(agent, signal, sourceCommandId) {
      compactions.push({ agent, signal, sourceCommandId });
      return { compactionId: "native-compact-1", batchCount: 2 };
    },
  };
  const context = {
    agents: {
      get: (sessionId) => agents.get(sessionId),
      async create({ sessionId, meta }) {
        const agent = {
          session: { id: sessionId, header: { cwd: meta.cwd, agentPreset: "suzu-companion" }, events: [] },
          // Scoped preset services are intentionally not visible through an
          // ordinary Agent context lookup; the host must resolve them via the
          // AgentPresets binding below.
          ctx: { get: () => undefined },
          followup(message) { followups.push(message); },
        };
        agents.set(sessionId, agent);
        return { agent };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: "test-provider", model: "test-model" }),
    },
    agentPresets: {
      async resolve(id) { return { id: id || "suzu-companion" }; },
      async mount() {},
      serviceFor(candidate, name) {
        return candidate === agents.get(candidate?.session?.id) && name === "compaction"
          ? compaction
          : undefined;
      },
    },
    get: () => undefined,
  };
  const host = new SuzuAgentHost(context, { send: () => true });

  await host.handle("sessions.create", {
    sessionId: "first-prompt-session",
    cwd: workspace,
    agentPreset: "suzu-companion",
  });
  await host.handle("sessions.prompt", {
    sessionId: "first-prompt-session",
    content: [{ type: "text", text: "你好" }],
  });
  const compacted = await host.handle("sessions.compact", {
    sessionId: "first-prompt-session",
  });

  assert.equal(followups.length, 1);
  assert.deepEqual(compacted, {
    accepted: true,
    completed: true,
    compactionId: "native-compact-1",
    batchCount: 2,
  });
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].agent.session.id, "first-prompt-session");
  assert.equal(compactions[0].signal.aborted, false);
  assert.match(compactions[0].sourceCommandId, /^suzu-manual-compaction-/u);
  await assert.rejects(
    host.handle("sessions.create", {
      sessionId: "first-prompt-session",
      cwd: resolve(TEST_DIRECTORY, "a-different-contact-workspace"),
      agentPreset: "suzu-companion",
    }),
    /已绑定到另一个工作目录/u,
  );
});

test("embedded host keeps the create-time model selection when Core's live default source is unavailable", () => {
  const host = new SuzuAgentHost({}, { send: () => true });
  const agent = {
    options: { provider: "suzu-test-provider", model: "suzu-test-model" },
    session: { requestHeader: () => undefined },
    ctx: {
      agentDefaultModel: { currentSelection: () => undefined },
      on: () => () => undefined,
    },
  };

  const selection = host.selectionFor(agent);
  assert.deepEqual(selection.current, {
    provider: "suzu-test-provider",
    model: "suzu-test-model",
  });
});

test("embedded Suzu host and private resolver are concrete", async () => {
  assert.equal(existsSync(resolveEmbeddedSuzuAgentHost()), true);
  assert.equal(existsSync(resolveEmbeddedSuzuAgentModuleLoader()), true);
  const resolved = await resolveEmbeddedModule(
    "@suzu-lives/suzu-agent-runtime/core/session",
    {},
    async () => { throw new Error("ordinary root does not carry the selected kernel"); },
  );
  assert.equal(resolved.shortCircuit, true);
  assert.match(new URL(resolved.url).pathname.replaceAll("%20", " ").replaceAll("\\", "/"), /packages\/suzu-agent-runtime\/vendor\/core\/modules\/session\.mjs/u);

  const nativeEsm = await resolveEmbeddedModule(
    "koffi",
    { conditions: ["node", "import"] },
    async () => { throw new Error("ordinary root does not carry the private native dependency"); },
  );
  assert.equal(nativeEsm.shortCircuit, true);
  assert.match(new URL(nativeEsm.url).pathname.replaceAll("%20", " ").replaceAll("\\", "/"), /packages\/suzu-agent-runtime\/vendor\/core\/node_modules\/koffi\/index\.js/u);
});
