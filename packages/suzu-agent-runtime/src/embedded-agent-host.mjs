import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SUZU_AGENT_HOST_IPC_PROTOCOL,
  normalizeSuzuAgentHostIpcMessage,
} from "./agent-host-ipc.mjs";
import {
  importSuzuAgentCoreModule,
  resolveSuzuAgentCoreBundleAnchor,
} from "./core-bundle.mjs";

const {
  boot,
  installFailLoud,
  loadLayeredEnv,
  loadOverlayPatches,
} = await importSuzuAgentCoreModule("app-boot");
// The selected execution layer uses this stable Cordis service key internally.
const SUZU_AGENT_LAUNCH_ENVIRONMENT_KEY = "launchEnvironment";
const { installModelSelection } = await importSuzuAgentCoreModule("agent");
const { credentialRef } = await importSuzuAgentCoreModule("credentials");
const { createUserMessage } = await importSuzuAgentCoreModule("llm");
const { resolveSessionPreset } = await importSuzuAgentCoreModule("agent-presets");

const MODULE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const CORE_CONFIG_FILE = resolve(MODULE_DIRECTORY, "..", "assets", "suzu-agent-core", "cordis.yml");
const CORE_PATCH_FILE = resolve(MODULE_DIRECTORY, "..", "assets", "suzu-agent-core", "cordis.patch.yml");
const MAX_IDENTIFIER_LENGTH = 256;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function modelSelection(value) {
  const source = plainObject(value);
  const provider = clean(source.provider);
  const model = clean(source.model);
  if (!provider || !model) return null;
  return {
    provider,
    model,
    ...(clean(source.reasoningEffort) ? { reasoningEffort: clean(source.reasoningEffort) } : {}),
  };
}

function identifier(value, label) {
  const normalized = clean(value);
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`${label}无效。`);
  }
  return normalized;
}

function secretValue(value, label) {
  const normalized = String(value ?? "");
  if (!normalized || normalized.length > 1_000 || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`${label}无效。`);
  }
  return normalized;
}

function requiredAbsoluteDirectory(value, label) {
  const source = clean(value);
  if (!source || !isAbsolute(source)) throw new Error(`${label}必须是绝对目录。`);
  return resolve(source);
}

function boundedError(error, fallback = "Suzu Agent Core 操作失败。") {
  const source = error instanceof Error ? error : new Error(String(error ?? ""));
  return {
    code: clean(source.code) || "SUZU_AGENT_CORE_ERROR",
    message: clean(source.message) || fallback,
  };
}

function responseOk(value = {}) {
  return { ok: true, value };
}

function responseError(error) {
  return { ok: false, error: boundedError(error) };
}

function namespaceView(descriptor) {
  const source = plainObject(descriptor);
  return {
    ns: String(source.ns ?? ""),
    schema: source.schema,
    value: source.value,
    ...(source.base === undefined ? {} : { base: source.base }),
    ...(source.user === undefined ? {} : { user: source.user }),
    applies: source.applies || "live",
    secrets: Array.isArray(source.secrets) ? source.secrets.map((secret) => ({
      path: Array.isArray(secret?.path) ? [...secret.path] : [],
      set: secret?.set === true,
    })) : [],
    revision: Number(source.revision) || 0,
  };
}

async function modelCatalog(ctx) {
  const groups = [];
  const failures = [];
  for (const provider of ctx.llm.listProviders()) {
    try {
      const models = await ctx.llm.listModels(provider.id);
      const entries = [];
      for (const model of models) {
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
        entries.push({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(info?.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
          ...(info?.context?.maxTokens === undefined ? {} : { maxTokens: info.context.maxTokens }),
        });
      }
      if (entries.length) groups.push({ id: provider.id, name: provider.name, models: entries });
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name, message: clean(error?.message) || "读取模型失败。" });
    }
  }
  return { groups, failures };
}

function promptBlocks(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("消息内容不能为空。 ");
  const blocks = value.map((entry) => plainObject(entry));
  if (blocks.some((block) => block.type !== "text" && block.type !== "image")) {
    throw new Error("消息只支持文本和图片内容。 ");
  }
  return blocks;
}

/**
 * Product-owned control plane for the selected execution kernel. It exposes a
 * small Node IPC surface; no socket, browser, HTTP proxy, or external desktop
 * application is started.
 */
export class SuzuAgentHost {
  constructor(context, { send = (message) => process.send?.(message) } = {}) {
    this.ctx = context;
    this.send = typeof send === "function" ? send : () => false;
    this.selections = new WeakMap();
    this.pendingApprovals = new Map();
    this.sessionCreations = new Map();
    this.disposers = [];
  }

  emit(channel, payload, rpcId = "") {
    try {
      this.send({
        protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
        kind: "event",
        channel,
        envelope: {
          ...(clean(rpcId) ? { rpcId: clean(rpcId) } : {}),
          payload,
        },
      });
    } catch {
      // A parent exiting must not destabilize an owned agent turn.
    }
  }

  start() {
    this.disposers.push(this.ctx.on("session/event", (session, event) => {
      this.emit("mux", {
        type: "session/event",
        sessionId: session.id,
        event,
      });
    }));

    this.disposers.push(this.ctx.on("approval/request", (request, next) => {
      if (request?.signal?.aborted) return Promise.resolve("cancelled");
      const approvalId = this.unresolvedApprovalId(request);
      if (!approvalId) return next();
      return new Promise((resolveApproval) => {
        const rpcId = `suzu-agent-approval-${randomUUID()}`;
        const settle = (outcome) => {
          const pending = this.pendingApprovals.get(rpcId);
          if (!pending) return;
          this.pendingApprovals.delete(rpcId);
          request.signal?.removeEventListener("abort", onAbort);
          this.emit("mux", {
            type: "approval/resolved",
            sessionId: pending.sessionId,
            approvalId: pending.approvalId,
            toolName: pending.toolName,
            callId: pending.callId,
            decision: outcome,
          });
          resolveApproval(outcome);
        };
        const onAbort = () => settle("cancelled");
        const pending = {
          rpcId,
          sessionId: request.agent.session.id,
          approvalId,
          toolName: clean(request.toolName) || "tool",
          callId: clean(request.callId),
          resolve: settle,
        };
        this.pendingApprovals.set(rpcId, pending);
        request.signal?.addEventListener("abort", onAbort, { once: true });
        this.emit("mux", {
          type: "approval/requested",
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          toolName: pending.toolName,
          ...(pending.callId ? { callId: pending.callId } : {}),
          ...(clean(request.reason) ? { reason: clean(request.reason) } : {}),
        }, rpcId);
      });
    }));
  }

  unresolvedApprovalId(request) {
    const session = request?.agent?.session;
    const events = Array.isArray(session?.events) ? session.events : [];
    const resolved = new Set();
    const claimed = new Set([...this.pendingApprovals.values()].map((entry) => entry.approvalId));
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = plainObject(events[index]);
      if (event.type === "approval/decided") resolved.add(clean(plainObject(event.data).id));
      if (event.type !== "approval/asked") continue;
      const data = plainObject(event.data);
      const id = clean(data.id);
      if (!id || resolved.has(id) || claimed.has(id)) continue;
      if ((clean(request?.callId) || "") !== (clean(data.callId) || "")) continue;
      return id;
    }
    return "";
  }

  selectionFor(agent) {
    const existing = this.selections.get(agent);
    if (existing) return existing;
    let chosen;
    const selection = {
      get current() {
        if (chosen) return chosen;
        // The product's main-model setting is a live, product-wide choice.
        // It must win over an old request header: otherwise changing the
        // setting after a contact's first turn would leave that contact
        // permanently pinned to its original provider/model.
        const live = modelSelection(agent.ctx.agentDefaultModel?.currentSelection?.());
        if (live) return live;
        // agentOptions is the selection captured while this Agent was
        // created or resumed. Keep it as the fallback when the Core's live
        // settings source is temporarily unavailable.
        const configured = modelSelection(agent.options);
        if (configured) return configured;
        // Older persisted sessions may predate either product-owned source.
        // Their recorded request header is still a safe last-resort route.
        const logged = modelSelection(plainObject(agent.session.requestHeader?.()).config);
        if (logged) return logged;
        throw new Error("Suzu Agent 缺少可用的主模型配置；请在“设置 → 主模型”保存后重试。 ");
      },
      set current(next) { chosen = next; },
      assembled: undefined,
    };
    installModelSelection(agent.ctx, selection);
    this.selections.set(agent, selection);
    return selection;
  }

  async compositionFor(presetId) {
    const presets = this.ctx.agentPresets;
    const resolved = await presets.resolve(presetId);
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        if (!agentCtx?.agent) throw new Error("Agent Core 创建 Agent 时缺少作用域。 ");
        this.selectionFor(agentCtx.agent);
        await presets.mount(agentCtx, resolved.id);
      },
    };
  }

  async ensureSession(payload) {
    const sessionId = identifier(payload.sessionId, "会话标识");
    // Session creation receives the contact workspace explicitly. Later requests
    // such as `sessions.prompt` intentionally carry only the session ID: they
    // must resume that already-bound workspace instead of silently substituting
    // the host process cwd (the product data root).
    const requestedCwd = clean(payload.cwd);
    const cwd = requestedCwd ? requiredAbsoluteDirectory(requestedCwd, "工作目录") : "";
    const requestedPreset = clean(payload.agentPreset) || undefined;
    let creation = this.sessionCreations.get(sessionId);
    if (!creation) {
      creation = (async () => {
        const live = this.ctx.agents.get(sessionId);
        if (live) return live;
        const persistence = this.ctx.get("sessionPersistence");
        const stored = persistence ? (await persistence.list()).find((entry) => entry.id === sessionId) : null;
        if (stored) {
          const inspected = await persistence.inspect(sessionId);
          if (cwd && clean(inspected?.meta?.cwd) && resolve(inspected.meta.cwd) !== cwd) {
            throw new Error(`会话 ${sessionId} 已绑定到另一个工作目录。`);
          }
          const storedPreset = resolveSessionPreset({ header: inspected.meta, events: inspected.events });
          if (requestedPreset && storedPreset && requestedPreset !== storedPreset) {
            throw new Error(`会话 ${sessionId} 已绑定到 ${storedPreset}，不能切换到 ${requestedPreset}。`);
          }
          const composition = await this.compositionFor(storedPreset || requestedPreset);
          const selection = this.ctx.agentDefaultModel.currentSelection();
          return (await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: composition.setup,
          })).agent;
        }
        if (!cwd) throw new Error("创建会话需要工作目录。 ");
        await mkdir(cwd, { recursive: true });
        const composition = await this.compositionFor(requestedPreset);
        const selection = this.ctx.agentDefaultModel.currentSelection();
        return (await this.ctx.agents.create({
          sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          meta: { cwd, agentPreset: composition.agentPreset },
          setup: composition.setup,
        })).agent;
      })().finally(() => this.sessionCreations.delete(sessionId));
      this.sessionCreations.set(sessionId, creation);
    }
    const agent = await creation;
    if (cwd && resolve(agent.session.header.cwd || cwd) !== cwd) {
      throw new Error(`会话 ${sessionId} 已绑定到另一个工作目录。`);
    }
    const storedPreset = resolveSessionPreset(agent.session);
    if (requestedPreset && storedPreset && requestedPreset !== storedPreset) {
      throw new Error(`会话 ${sessionId} 已绑定到 ${storedPreset}，不能切换到 ${requestedPreset}。`);
    }
    return agent;
  }

  async history(payload) {
    const sessionId = identifier(payload.sessionId, "会话标识");
    const live = this.ctx.sessions.get(sessionId);
    if (live) return { events: [...live.events], hasMore: false };
    const persistence = this.ctx.get("sessionPersistence");
    if (!persistence) throw new Error("会话持久化服务不可用。 ");
    const inspected = await persistence.inspect(sessionId);
    return { events: [...inspected.events], hasMore: false };
  }

  async handle(method, payload) {
    switch (method) {
      case "host.describe":
        return {
          runtime: "suzu-agent-core",
          transport: "node-ipc",
          version: "1",
        };
      case "sessions.create": {
        const agent = await this.ensureSession(payload);
        return { sessionId: agent.session.id, agentPreset: resolveSessionPreset(agent.session) };
      }
      case "sessions.history":
        return this.history(payload);
      case "sessions.prompt": {
        const agent = await this.ensureSession(payload);
        agent.followup(createUserMessage({
          content: promptBlocks(payload.content),
          source: { kind: "user" },
        }));
        return { accepted: true };
      }
      case "sessions.compact": {
        const agent = await this.ensureSession(payload);
        // This is product-owned maintenance, not a user message.  Sending
        // `/compact` through sessions.prompt would first create an ordinary
        // chat request with that model's full completion reservation, which
        // is exactly what prevents an already-large conversation from being
        // compacted.  The mounted native engine performs a durable, low-output
        // summary transaction instead.
        // A preset service is deliberately isolated from both the root host
        // and the Agent's ordinary context lookup.  AgentPresets owns the
        // binding between this Agent and its mounted composition, and exposes
        // serviceFor() specifically for resolving one of those scoped services.
        // This also keeps companion and software-assistant retention settings
        // independent when both compositions exist in the same Core process.
        const compaction = this.ctx.agentPresets?.serviceFor?.(agent, "compaction");
        if (!compaction || typeof compaction.compactNow !== "function") {
          throw new Error("Suzu Agent 会话压缩服务不可用。");
        }
        const result = await compaction.compactNow(
          agent,
          new AbortController().signal,
          `suzu-manual-compaction-${randomUUID()}`,
        );
        if (result === null) {
          return { accepted: true, completed: false, reason: "NO_COMPACTABLE_HISTORY" };
        }
        const compactionId = clean(result.compactionId);
        if (!compactionId) throw new Error("Suzu Agent 会话压缩没有返回记录标识。");
        return {
          accepted: true,
          completed: true,
          compactionId,
          ...(Number.isSafeInteger(result.batchCount) && result.batchCount > 1
            ? { batchCount: result.batchCount }
            : {}),
        };
      }
      case "sessions.cancel": {
        const sessionId = identifier(payload.sessionId, "会话标识");
        const agent = this.ctx.agents.get(sessionId);
        if (!agent) throw new Error("当前会话尚未启动。 ");
        agent.cancel({ kind: "user" }, { keepInbox: true });
        return { accepted: true };
      }
      case "respond": {
        const rpcId = identifier(payload.rpcId, "审批请求标识");
        const pending = this.pendingApprovals.get(rpcId);
        if (!pending) return { accepted: false };
        const outcome = clean(plainObject(plainObject(payload.result).value).outcome);
        if (outcome !== "allowed-once" && outcome !== "rejected") throw new Error("审批结果无效。 ");
        pending.resolve(outcome);
        return { accepted: true };
      }
      case "settings.describe": {
        const settings = this.ctx.settings;
        if (!settings) throw new Error("模型设置服务不可用。 ");
        return {
          writable: settings.writable === true,
          hasDocument: settings.documentPath !== undefined,
          namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
        };
      }
      case "settings.mutate": {
        const settings = this.ctx.settings;
        if (!settings) throw new Error("模型设置服务不可用。 ");
        const namespace = identifier(payload.ns, "设置命名空间");
        await settings.mutate(namespace, Array.isArray(payload.ops) ? payload.ops : [], payload.expectedRevision);
        const descriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === namespace);
        if (!descriptor) throw new Error("设置命名空间不存在。 ");
        return namespaceView(descriptor);
      }
      case "credentials.describe": {
        const credentials = this.ctx.credentials;
        if (!credentials) throw new Error("模型凭据服务不可用。 ");
        const refs = Array.isArray(payload.refs) ? payload.refs.slice(0, 64) : [];
        const entries = await Promise.all(refs.map(async (ref) => {
          const key = credentialRef(identifier(ref, "凭据标识"));
          const info = await credentials.describe(key);
          return [key, {
            configured: info.configured === true,
            ...(clean(info.source) ? { source: clean(info.source) } : {}),
            writable: info.writable !== false,
          }];
        }));
        return { credentials: Object.fromEntries(entries) };
      }
      case "credentials.set": {
        const credentials = this.ctx.credentials;
        if (!credentials) throw new Error("模型凭据服务不可用。 ");
        await credentials.set(credentialRef(identifier(payload.ref, "凭据标识")), secretValue(payload.value, "凭据"));
        return {};
      }
      case "llm.models":
        return modelCatalog(this.ctx);
      case "llm.discover-models": {
        const request = plainObject(payload);
        const models = await this.ctx.llm.discoverModels(identifier(request.settingsNs, "模型设置命名空间"), {
          ...(clean(request.provider) ? { provider: clean(request.provider) } : {}),
          ...(clean(request.baseURL) ? { baseURL: clean(request.baseURL) } : {}),
          ...(clean(request.api) ? { api: clean(request.api) } : {}),
          ...(clean(request.apiKey) ? { apiKey: clean(request.apiKey) } : {}),
        });
        return { models };
      }
      default:
        throw new Error(`Suzu Agent Core 不支持请求：${method}。`);
    }
  }

  async dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose?.(); } catch { /* Context disposal owns the final cleanup. */ }
    }
    for (const pending of this.pendingApprovals.values()) pending.resolve("cancelled");
    this.pendingApprovals.clear();
  }
}

export function parseEmbeddedSuzuAgentHostArguments(values = []) {
  const args = Array.isArray(values) ? [...values] : [];
  const patchFiles = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--patch") throw new Error(`Suzu Agent Core 不支持参数：${clean(option) || "<空>"}。`);
    const candidate = clean(args[++index]);
    if (!candidate || !isAbsolute(candidate)) throw new Error("Suzu Agent Core 配置补丁必须是绝对路径。 ");
    patchFiles.push(resolve(candidate));
  }
  return Object.freeze({ patchFiles: Object.freeze(patchFiles) });
}

export async function runEmbeddedSuzuAgentHost({ argv = process.argv.slice(2), send = (message) => process.send?.(message) } = {}) {
  const startup = parseEmbeddedSuzuAgentHostArguments(argv);
  const patches = [
    ...loadOverlayPatches("suzu-agent-core", CORE_PATCH_FILE),
    ...startup.patchFiles.flatMap((file) => loadOverlayPatches("suzu-agent-core", file)),
  ];
  let context = null;
  let host = null;
  let closing = null;
  const shutdown = (code = 0) => {
    if (!closing) {
      closing = Promise.resolve()
        .then(() => host?.dispose())
        .then(() => context?.fiber.dispose())
        .finally(() => { process.exitCode = code; });
    }
    return closing;
  };
  process.once("SIGTERM", () => { void shutdown(0); });
  process.once("SIGINT", () => { void shutdown(130); });
  installFailLoud("suzu-agent-core", process, () => shutdown(1));
  context = await boot(
    "suzu-agent-core",
    CORE_CONFIG_FILE,
    structuredClone(patches),
    (hostContext) => {
      context = hostContext;
      hostContext.provide(SUZU_AGENT_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv("suzu-agent-core"));
    },
    pathToFileURL(resolveSuzuAgentCoreBundleAnchor()).href,
  );
  host = new SuzuAgentHost(context, { send });
  host.start();
  process.on("message", (raw) => {
    const message = normalizeSuzuAgentHostIpcMessage(raw);
    if (!message || message.kind !== "request") return;
    Promise.resolve(host.handle(message.method, message.payload))
      .then((value) => send({
        protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
        kind: "response",
        requestId: message.requestId,
        result: responseOk(value),
      }))
      .catch((error) => send({
        protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
        kind: "response",
        requestId: message.requestId,
        result: responseError(error),
      }));
  });
  send({
    protocol: SUZU_AGENT_HOST_IPC_PROTOCOL,
    kind: "ready",
    details: { runtime: "suzu-agent-core", transport: "node-ipc" },
  });
  return { context, host };
}

if (process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(resolve(process.argv[1])).href) {
  runEmbeddedSuzuAgentHost().catch((error) => {
    process.stderr.write(`suzu-agent-core: ${clean(error?.stack || error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
