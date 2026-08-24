import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT } from "@suzu-lives/suzu-agent-runtime/software-assistant-compaction-prompt";
import { formatErrorForDisplay } from "@suzu-lives/suzu-agent-runtime/error-detail";
import {
  DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS,
  DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD,
} from "@suzu-lives/suzu-agent-runtime/compaction-defaults";

import { SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET } from "./suzu-agent-runtime.mjs";
import { conversationDisplayMessages } from "./conversation-reader.mjs";
import { completedConversationReplyPrefix } from "../../shared/conversation-reply-segmentation.mjs";
import {
  SUZU_SEARCH_ITEMS,
  getSuzuSearchItem,
} from "../../src/core/suzu-search.mjs";

export const SUZU_SOFTWARE_ASSISTANT_SESSION_ID = "suzu-software-assistant";
export const SUZU_SOFTWARE_ASSISTANT_AGENT_ID = "suzu-software-assistant";
export const SUZU_SOFTWARE_ASSISTANT_NAME = "suzu助手";
const MAX_HISTORY_MESSAGES = 300;
const MAX_USAGE_HISTORY_MESSAGES = 2_000;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_STREAMED_TEXT_LENGTH = 100_000;
const MAX_AVATAR_DATA_URL_LENGTH = 2_800_000;
const MAX_AVATAR_FILE_BYTES = 2_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class SoftwareAssistantServiceError extends Error {
  constructor(message, { cause, code = "SOFTWARE_ASSISTANT_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SoftwareAssistantServiceError";
    this.code = code;
  }
}

export { SoftwareAssistantServiceError };

function clean(value) {
  return String(value ?? "").trim();
}

function errorMessage(error, fallback) {
  return formatErrorForDisplay(error, { fallback });
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function avatarMimeType(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0);
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "";
}

function identityWithAgentAvatar(settings, agentId, avatarDataUrl) {
  const identity = plainObject(settings?.identity);
  const agents = plainObject(identity.agents);
  const currentProfile = plainObject(agents[agentId]);
  const fallbackProfile = plainObject(identity.defaultAgent);
  return {
    owner: { ...plainObject(identity.owner) },
    defaultAgent: { ...fallbackProfile },
    agents: {
      ...agents,
      [agentId]: {
        ...(Object.keys(currentProfile).length ? currentProfile : fallbackProfile),
        avatarDataUrl,
      },
    },
  };
}

function requiredDirectory(value, label) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) {
    throw new SoftwareAssistantServiceError(`${label}必须是绝对目录。`, { code: "WORKSPACE_INVALID" });
  }
  return path.resolve(source);
}

function optionalAbsolutePath(value) {
  const source = clean(value);
  return source && path.isAbsolute(source) ? path.resolve(source) : "";
}

function bounded(value, limit = MAX_STREAMED_TEXT_LENGTH) {
  const text = String(value ?? "");
  const suffix = "…";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}` : text;
}

function mergeFullText(previous, next) {
  const current = bounded(previous);
  const candidate = bounded(next);
  if (!candidate) return current;
  if (!current || candidate.startsWith(current)) return candidate;
  if (current.startsWith(candidate)) return current;
  if (current.endsWith(candidate)) return current;
  return bounded(`${current}${candidate}`);
}

function completedAssistantMessageCount(event) {
  const value = Number(event?.data?.assistantMessageCount);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function visibleMessages(events) {
  return conversationDisplayMessages(events, MAX_HISTORY_MESSAGES)
    // Product work should remain inspectable in this chat, including native
    // tool calls and results. They are rendered with the normal conversation
    // detail cards instead of being folded into the final answer.
    .filter((message) => ["user", "assistant", "system"].includes(clean(message?.kind)));
}

function historyEventSequence(entry) {
  const source = plainObject(entry);
  const wrapped = plainObject(source.event);
  const sequence = Number(Object.keys(wrapped).length ? wrapped.seq : source.seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function oldestHistorySequence(events) {
  const sequences = (Array.isArray(events) ? events : [])
    .map(historyEventSequence)
    .filter((sequence) => sequence !== null);
  return sequences.length ? Math.min(...sequences) : null;
}

function modelStatusLine() {
  return "主模型使用“设置 → 主模型”中已保存的全局默认连接；此状态摘要不展开服务商、模型标识或连接详情。";
}

function destinationIndex() {
  return SUZU_SEARCH_ITEMS
    .map((entry) => `- ${entry.title}（${entry.id}）：${entry.detail}。`)
    .join("\n");
}

function capabilityStatus() {
  // Built-in capability enablement is contact-scoped, while external Skill/MCP
  // registration belongs to the shared Agent Core. This product helper does not
  // inspect per-contact state because its own contact scope is deliberately empty.
  return "内置软件能力按联系人分别启用；外部 Skill/MCP 登记到全局 Agent Core，供所有联系人共享。此状态摘要不枚举具体能力配置。";
}

/** Resolves the managed workspace for the product helper. */
export function resolveSoftwareAssistantWorkspace(dataRoot) {
  return path.join(requiredDirectory(dataRoot, "Suzu 软件数据目录"), "software-assistant", "workspace");
}

/** Returns the stable non-contact owner used by the unified cost ledger. */
export function softwareAssistantUsageSubject(dataRoot) {
  return Object.freeze({
    agentId: SUZU_SOFTWARE_ASSISTANT_AGENT_ID,
    projectRoot: resolveSoftwareAssistantWorkspace(dataRoot),
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    subjectId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    subjectName: SUZU_SOFTWARE_ASSISTANT_NAME,
    subjectType: "system-assistant",
  });
}

/**
 * A dedicated conversation service for the built-in product helper. It keeps
 * a fixed session and workspace, and receives live product state per request.
 * Its normal local tools may still inspect a local file when the user asks it
 * to diagnose that specific data, just like any other local Agent.
 */
export function createSoftwareAssistantService({
  applicationPath = "",
  contactSnapshot = null,
  createContact = null,
  dataRoot,
  runtime,
  saveRelationshipFile = null,
  settingsService,
  usageLedger = null,
  fsOps = fs,
  onEvent = () => {},
} = {}) {
  if (typeof runtime?.ensureSession !== "function" || typeof runtime?.history !== "function" || typeof runtime?.sendTurn !== "function" || typeof runtime?.cancelTurn !== "function" || typeof runtime?.purgeSession !== "function" || typeof runtime?.respondLifecycleRequest !== "function" || typeof runtime?.subscribe !== "function") {
    throw new SoftwareAssistantServiceError("软件助手需要完整的 Agent Core 会话运行时。", { code: "RUNTIME_REQUIRED" });
  }
  if (!settingsService?.load || !settingsService?.update) {
    throw new SoftwareAssistantServiceError("软件助手需要软件设置服务。", { code: "SETTINGS_REQUIRED" });
  }
  if (!fsOps?.mkdir) {
    throw new SoftwareAssistantServiceError("软件助手需要本机文件接口。", { code: "FILESYSTEM_REQUIRED" });
  }
  if ((contactSnapshot !== null && typeof contactSnapshot !== "function")
    || (createContact !== null && typeof createContact !== "function")
    || (saveRelationshipFile !== null && typeof saveRelationshipFile !== "function")) {
    throw new SoftwareAssistantServiceError("软件助手的联系人操作接口无效。", { code: "CONTACT_ACTIONS_INVALID" });
  }
  if (usageLedger !== null
    && (typeof usageLedger?.record !== "function" || typeof usageLedger?.reconcile !== "function")) {
    throw new SoftwareAssistantServiceError("软件助手的费用记录接口无效。", { code: "USAGE_LEDGER_INVALID" });
  }

  const dataDirectory = requiredDirectory(dataRoot, "Suzu 软件数据目录");
  const workspaceDirectory = resolveSoftwareAssistantWorkspace(dataDirectory);
  const usageSubject = softwareAssistantUsageSubject(dataDirectory);
  const installedApplicationPath = optionalAbsolutePath(applicationPath);
  const presentation = Object.freeze({ agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET });
  const subscribers = new Set();
  const activeTurns = new Map();
  const pendingTurns = [];
  let pumpTurns = () => undefined;
  let preparation = null;
  let usageHistoryReconciliation = null;
  let usageHistoryFullyReconciled = false;
  let disposed = false;

  const emit = (event) => {
    const payload = Object.freeze({
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      timestamp: new Date().toISOString(),
      ...plainObject(event),
    });
    try { onEvent(payload); } catch { /* The main IPC sender is optional. */ }
    for (const listener of subscribers) {
      try { listener(payload); } catch { /* One observer cannot stop Agent Core. */ }
    }
    return payload;
  };

  const scope = () => ({
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    cwd: workspaceDirectory,
    presentation,
  });

  const prepareWorkspace = async () => {
    if (preparation) return preparation;
    preparation = (async () => {
      await fsOps.mkdir(workspaceDirectory, { recursive: true });
    })().catch((error) => {
      preparation = null;
      throw error;
    });
    return preparation;
  };

  const ensureSession = async () => {
    if (disposed) throw new SoftwareAssistantServiceError("软件助手已经停止。", { code: "SERVICE_STOPPED" });
    await prepareWorkspace();
    return runtime.ensureSession(scope());
  };

  const currentStatus = async ({ includeDestinations = true } = {}) => {
    const settings = plainObject(settingsService.load());
    const theme = settings.theme === "dark" ? "深色" : "浅色";
    const lines = [
      `当前外观：${theme}主题。`,
      modelStatusLine(),
      capabilityStatus(),
      `软件数据目录：${dataDirectory}。`,
      installedApplicationPath ? `软件本体/源码位置：${installedApplicationPath}。` : "软件本体路径未提供；可先从软件数据目录排查。",
      "需要确认时，可用本机文件、搜索和 PowerShell 工具检查这些位置；将配置和源码作为本机事实依据处理。",
      "联系人资料、相处设定、长期记忆和联系人聊天记录按用户明确的排查范围读取。",
    ];
    if (includeDestinations) {
      lines.push("已登记的软件入口（打开页面时使用括号中的 ID）：", destinationIndex());
    }
    return lines.join("\n");
  };

  const dynamicContext = async () => ({
    blocks: [{
      id: "software-assistant:runtime-state",
      kind: "software-state",
      source: "software-assistant",
      priority: 100,
      display: { context: true, transcript: false, category: "software-assistant", label: "Suzu Lives 软件状态" },
      text: [
        "本轮 Suzu Lives 软件状态：",
        await currentStatus({ includeDestinations: false }),
        "依据用户目标加载对应的产品使用 Skill。需要状态或页面入口时调用 suzu_software_status；需要执行已登记的软件操作时调用 suzu_software_action。",
      ].join("\n\n"),
    }],
  });

  const respond = async (requestId, result) => {
    try {
      return await runtime.respondLifecycleRequest({ requestId, result });
    } catch {
      return false;
    }
  };

  const performAction = async ({ action, input }) => {
    const body = plainObject(input);
    if (action === "navigate") {
      const destinationId = clean(body.destinationId);
      const entry = getSuzuSearchItem(destinationId);
      if (!entry) return {
        status: "invalid-request",
        content: "这个页面入口不存在；请先读取当前软件状态中的入口 ID。",
        data: null,
      };
      emit({ type: "navigate", destinationId: entry.id });
      return {
        status: "completed",
        content: `已打开“${entry.title}”。`,
        data: { destinationId: entry.id },
      };
    }
    if (action === "set-theme") {
      const theme = clean(body.theme).toLowerCase();
      if (!new Set(["light", "dark"]).has(theme)) {
        return {
          status: "invalid-request",
          content: "主题只能是 light 或 dark。",
          data: null,
        };
      }
      await settingsService.update({ theme });
      emit({ type: "theme-changed", theme });
      return {
        status: "completed",
        content: theme === "dark" ? "已切换为深色主题。" : "已切换为浅色主题。",
        data: { theme },
      };
    }
    if (action === "set-contact-avatar") {
      const requestedContactId = clean(body.contactId);
      const requestedContactName = clean(body.contactName);
      const avatarPath = clean(body.avatarPath);
      if (!requestedContactId && !requestedContactName) {
        return {
          status: "invalid-request",
          content: "设置联系人头像需要提供 contactId 或 contactName。",
          data: null,
        };
      }
      if (!avatarPath || !path.isAbsolute(avatarPath)) {
        return {
          status: "invalid-request",
          content: "设置联系人头像需要提供已下载图片的绝对路径 avatarPath。",
          data: null,
        };
      }
      if (typeof contactSnapshot !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接联系人资料读取功能。",
          data: null,
        };
      }

      let snapshot;
      try {
        snapshot = await contactSnapshot();
      } catch (error) {
        return {
          status: "failed",
          content: `无法读取联系人：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      const contacts = (Array.isArray(snapshot?.contacts) ? snapshot.contacts : [])
        .map((contact) => plainObject(contact));
      const matches = requestedContactId
        ? contacts.filter((contact) => clean(contact.id) === requestedContactId)
        : contacts.filter((contact) => clean(contact.name).toLocaleLowerCase() === requestedContactName.toLocaleLowerCase());
      if (!matches.length) {
        return {
          status: "invalid-request",
          content: requestedContactId
            ? `找不到联系人 ID“${requestedContactId}”。`
            : `找不到联系人“${requestedContactName}”。`,
          data: null,
        };
      }
      if (matches.length > 1) {
        const matchedName = clean(matches[0].name) || requestedContactName;
        return {
          status: "needs-confirmation",
          content: `有多位联系人名为“${matchedName}”；请确认联系人 ID 后再设置头像。`,
          data: {
            candidates: matches.map((contact) => ({
              contactId: clean(contact.id),
              name: clean(contact.name),
            })),
          },
        };
      }

      const contact = matches[0];
      const contactId = clean(contact.id);
      const contactName = clean(contact.name) || requestedContactName;
      const agentId = clean(contact.agentId);
      if (!contactId || !agentId) {
        return {
          status: "failed",
          content: "联系人缺少固定存储身份，当前无法保存头像。",
          data: null,
        };
      }
      if (typeof fsOps?.stat !== "function" || typeof fsOps?.readFile !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接头像文件读取功能。",
          data: null,
        };
      }

      let avatarBytes;
      try {
        const resolvedAvatarPath = path.resolve(avatarPath);
        const stat = await fsOps.stat(resolvedAvatarPath);
        if (!stat.isFile()) {
          return {
            status: "invalid-request",
            content: "avatarPath 必须指向一个图片文件。",
            data: null,
          };
        }
        if (stat.size > MAX_AVATAR_FILE_BYTES) {
          return {
            status: "invalid-request",
            content: "头像图片过大；请换用不超过 2 MB 的 PNG、JPEG 或 WebP 图片。",
            data: null,
          };
        }
        avatarBytes = await fsOps.readFile(resolvedAvatarPath);
      } catch (error) {
        return {
          status: "failed",
          content: `无法读取头像图片：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      if (!(Buffer.isBuffer(avatarBytes) || avatarBytes instanceof Uint8Array)
        || avatarBytes.length > MAX_AVATAR_FILE_BYTES) {
        return {
          status: "invalid-request",
          content: "头像图片过大；请换用不超过 2 MB 的 PNG、JPEG 或 WebP 图片。",
          data: null,
        };
      }
      const mimeType = avatarMimeType(avatarBytes);
      if (!mimeType) {
        return {
          status: "invalid-request",
          content: "头像图片格式无法识别；请选择 PNG、JPEG 或 WebP 图片。",
          data: null,
        };
      }
      const avatarDataUrl = `data:${mimeType};base64,${Buffer.from(avatarBytes).toString("base64")}`;
      if (avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
        return {
          status: "invalid-request",
          content: "头像图片过大；请换用不超过 2 MB 的 PNG、JPEG 或 WebP 图片。",
          data: null,
        };
      }

      try {
        const identity = identityWithAgentAvatar(settingsService.load(), agentId, avatarDataUrl);
        const updatedSettings = await settingsService.update({ identity });
        const persistedSettings = plainObject(updatedSettings);
        const persistedIdentity = plainObject(persistedSettings.identity);
        const persistedAgents = plainObject(persistedIdentity.agents);
        if (String(plainObject(persistedAgents[agentId]).avatarDataUrl || "") !== avatarDataUrl) {
          return {
            status: "failed",
            content: "联系人头像未能写入设置。",
            data: null,
          };
        }
      } catch (error) {
        return {
          status: "failed",
          content: `无法保存联系人头像：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      emit({ type: "contact-avatar-changed", contactId, contactName, agentId });
      return {
        status: "completed",
        content: `已为联系人“${contactName}”设置头像。`,
        data: { contactId, name: contactName, agentId, mimeType },
      };
    }
    if (action === "create-contact") {
      const name = clean(body.name);
      const personaContent = clean(body.personaContent);
      if (!name) {
        return {
          status: "invalid-request",
          content: "新建联系人需要提供联系人名称。",
          data: null,
        };
      }
      if (typeof createContact !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接联系人创建功能。",
          data: null,
        };
      }
      if (personaContent && typeof saveRelationshipFile !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接联系人相处设定功能。",
          data: null,
        };
      }

      let created;
      try {
        created = await createContact({ name });
      } catch (error) {
        return {
          status: "failed",
          content: `无法新建联系人：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      const createdContact = plainObject(created?.createdContact);
      const contactId = clean(createdContact.id);
      const contact = plainObject((Array.isArray(created?.contacts) ? created.contacts : [])
        .find((item) => clean(plainObject(item).id) === contactId));
      const contactName = clean(contact.name) || name;
      if (!contactId) {
        return {
          status: "failed",
          content: "联系人已创建，但当前无法确认新联系人的状态。",
          data: { name: contactName },
        };
      }

      const announceContact = () => {
        emit({ type: "contact-created", contactId, contactName });
        emit({ type: "navigate", destinationId: "conversation" });
      };
      if (personaContent) {
        try {
          await saveRelationshipFile({ contactId, path: "persona.md", content: personaContent });
        } catch (error) {
          announceContact();
          return {
            status: "partial",
            content: `已新建联系人“${contactName}”，但人设未能写入：${errorMessage(error, "未知错误。")}`,
            data: {
              contactId,
              name: contactName,
              personaSaved: false,
              destinationId: "conversation",
            },
          };
        }
      }
      announceContact();
      return {
        status: "completed",
        content: personaContent ? `已新建联系人“${contactName}”，并写入人设。` : `已新建联系人“${contactName}”。`,
        data: {
          contactId,
          name: contactName,
          personaSaved: Boolean(personaContent),
          destinationId: "conversation",
        },
      };
    }
    return {
      status: "invalid-request",
      content: "这个软件动作尚未登记；请先读取当前软件状态并加载相关产品 Skill。",
      data: null,
    };
  };

  const handleLifecycleRequest = async (event) => {
    const source = plainObject(event);
    const data = plainObject(source.data);
    if (clean(data.sessionId) !== SUZU_SOFTWARE_ASSISTANT_SESSION_ID) return;
    const requestId = clean(source.requestId);
    if (!requestId) return;
    const lifecycleEvent = clean(source.lifecycleEvent);
    if (lifecycleEvent === "ContextCollect") {
      // The helper receives live product state through the one-turn dynamic
      // context block above, which keeps each request grounded in current facts.
      await respond(requestId, { blocks: [] });
      return;
    }
    if (lifecycleEvent === "DynamicContextCollect") {
      await respond(requestId, await dynamicContext());
      return;
    }
    if (lifecycleEvent === "CompactionSettings") {
      await respond(requestId, {
        available: true,
        prompt: DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT,
        automatic: {
          enabled: true,
          tokenThreshold: DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD,
          retainTokens: DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS,
        },
        manual: { retainTokens: DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS },
      });
      return;
    }
    if (lifecycleEvent === "PreToolUse") {
      await respond(requestId, { decision: { kind: "allow" } });
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantStatus") {
      await respond(requestId, { content: await currentStatus() });
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantAction") {
      let result;
      try {
        result = await performAction({ action: clean(data.action), input: data.input });
      } catch (error) {
        result = {
          status: "failed",
          content: `软件动作执行失败：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      await respond(requestId, result);
    }
  };

  const finishTurn = async (turn, event = {}) => {
    if (!turn || turn.finished) return;
    turn.finished = true;
    activeTurns.delete(turn.requestId);
    if (turn.usageTasks?.length) await Promise.allSettled(turn.usageTasks);
    if (event.error) {
      emit({ type: "error", requestId: turn.requestId, message: clean(event.error) || "软件助手没有完成这次回复。" });
      if (!disposed) void pumpTurns();
      return;
    }
    if (event.stopped) {
      emit({ type: "turn-stopped", requestId: turn.requestId, message: "已停止当前回复。" });
      if (!disposed) void pumpTurns();
      return;
    }
    emit({ type: "turn-complete", requestId: turn.requestId });
    if (!disposed) void pumpTurns();
  };

  const requestCancellation = async (turn) => {
    if (!turn || turn.finished || turn.cancelTask || turn.state !== "running") return;
    turn.cancelTask = Promise.resolve(runtime.cancelTurn({
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      turnId: turn.requestId,
    }))
      .catch((error) => {
        if (!turn.finished) finishTurn(turn, {
          error: `无法停止当前回复：${errorMessage(error, "停止失败。")}`,
        });
      })
      .finally(() => { turn.cancelTask = null; });
    await turn.cancelTask;
  };

  const emitReplyStream = (turn) => {
    const content = completedConversationReplyPrefix(turn.text);
    if (!content || content === turn.streamedReplyContent) return;
    turn.streamedReplyContent = content;
    emit({ type: "reply-stream", requestId: turn.requestId, content });
  };

  const handleRuntimeEvent = (event) => {
    const source = plainObject(event);
    if (source.type === "lifecycle-request") {
      void handleLifecycleRequest(source);
      return;
    }
    if (clean(source.sessionId) !== SUZU_SOFTWARE_ASSISTANT_SESSION_ID) return;
    const type = clean(source.type);
    const turn = activeTurns.get(clean(source.turnId));
    if (type === "model-usage") {
      const task = Promise.resolve(usageLedger?.record({
        event: source,
        subject: usageSubject,
        turn: turn || null,
      })).catch(() => undefined);
      if (turn && !turn.finished) turn.usageTasks.push(task);
      return;
    }
    if (!turn || turn.finished) return;
    if (type === "turn-started") {
      turn.state = "running";
      emit({ type: "turn-started", requestId: turn.requestId });
      if (turn.cancelRequested) void requestCancellation(turn);
      return;
    }
    if (type === "tool-started") {
      turn.toolNames.add(clean(source.toolName) || "Suzu 工具");
      return;
    }
    if (type === "assistant-reasoning-delta") {
      emit({ type: "thinking", requestId: turn.requestId });
      return;
    }
    if (type === "assistant-delta") {
      turn.text = bounded(`${turn.text}${String(source.text || "")}`);
      emitReplyStream(turn);
      return;
    }
    if (type === "assistant-completed") {
      turn.text = mergeFullText(turn.text, source.text);
      if (turn.text) {
        emit({
          type: "reply",
          requestId: turn.requestId,
          content: turn.text,
          done: true,
          assistantMessageCount: completedAssistantMessageCount(source),
        });
      }
      void finishTurn(turn);
      return;
    }
    if (type === "turn-cancelled") {
      void finishTurn(turn, { stopped: true });
      return;
    }
    if (["turn-failed", "runtime-unavailable"].includes(type)) {
      void finishTurn(turn, { error: clean(source.error) });
    }
  };

  const submitTurn = async (turn) => {
    activeTurns.set(turn.requestId, turn);
    try {
      const result = await runtime.sendTurn({
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        turnId: turn.requestId,
        input: turn.input,
        placement: "queue",
      });
      if (result?.accepted !== true) {
        throw new SoftwareAssistantServiceError("Agent Core 没有接受这条软件助手消息。", { code: "TURN_NOT_ACCEPTED" });
      }
      if (!turn.finished && turn.state === "submitting") turn.state = "submitted";
      if (turn.cancelRequested) void requestCancellation(turn);
      return result;
    } catch (error) {
      if (!turn.finished) {
        await finishTurn(turn, { error: `无法发送给软件助手：${errorMessage(error, "未知错误。")}` });
      }
      throw error;
    }
  };

  pumpTurns = async () => {
    if (disposed || activeTurns.size) return;
    const next = pendingTurns.shift();
    if (!next) return;
    try {
      await submitTurn(next);
    } catch {
      // submitTurn has already emitted the visible error and will advance the queue.
    }
  };

  const unsubscribeRuntime = runtime.subscribe(handleRuntimeEvent);

  const reconcileUsagePage = async (events) => {
    const result = await usageLedger?.reconcile({
      events: Array.isArray(events) ? events : [],
      subject: usageSubject,
    });
    return result?.completed !== false;
  };

  const reconcileUsageHistory = async (latestHistory) => {
    if (!usageLedger) return;
    const latestEvents = Array.isArray(latestHistory?.events) ? latestHistory.events : [];
    if (!await reconcileUsagePage(latestEvents)) return;
    if (usageHistoryFullyReconciled) return;
    if (latestHistory?.hasMore !== true) {
      usageHistoryFullyReconciled = true;
      return;
    }
    if (!usageHistoryReconciliation) {
      usageHistoryReconciliation = (async () => {
        let beforeSeq = oldestHistorySequence(latestEvents);
        const visitedCursors = new Set();
        while (Number.isSafeInteger(beforeSeq) && !visitedCursors.has(beforeSeq)) {
          visitedCursors.add(beforeSeq);
          const history = await runtime.history({
            ...scope(),
            beforeSeq,
            maxMessages: MAX_USAGE_HISTORY_MESSAGES,
          });
          const events = Array.isArray(history?.events) ? history.events : [];
          if (!await reconcileUsagePage(events)) return false;
          if (history?.hasMore !== true) {
            usageHistoryFullyReconciled = true;
            return true;
          }
          const nextBeforeSeq = oldestHistorySequence(events);
          if (!Number.isSafeInteger(nextBeforeSeq) || nextBeforeSeq >= beforeSeq) return false;
          beforeSeq = nextBeforeSeq;
        }
        return false;
      })().finally(() => {
        usageHistoryReconciliation = null;
      });
    }
    await usageHistoryReconciliation;
  };

  const snapshot = async () => {
    try {
      await ensureSession();
      const history = await runtime.history({ ...scope(), maxMessages: MAX_HISTORY_MESSAGES });
      const events = Array.isArray(history?.events) ? history.events : [];
      await reconcileUsageHistory(history).catch(() => undefined);
      return Object.freeze({
        status: "ready",
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        workspaceDirectory,
        messages: visibleMessages(events),
        running: activeTurns.size > 0 || pendingTurns.length > 0,
      });
    } catch (error) {
      return Object.freeze({
        status: "unavailable",
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        workspaceDirectory,
        messages: [],
        running: activeTurns.size > 0 || pendingTurns.length > 0,
        error: errorMessage(error, "软件助手暂时无法启动。"),
      });
    }
  };

  const send = async ({ content } = {}) => {
    if (disposed) throw new SoftwareAssistantServiceError("软件助手已经停止。", { code: "SERVICE_STOPPED" });
    const text = clean(content);
    if (!text) throw new SoftwareAssistantServiceError("请输入要问 Suzu 的内容。", { code: "EMPTY_MESSAGE" });
    if (text.length > MAX_MESSAGE_LENGTH) throw new SoftwareAssistantServiceError("这条问题太长，请拆成更短的几条。", { code: "MESSAGE_TOO_LONG" });
    await ensureSession();
    const requestId = `suzu-software-${randomUUID()}`;
    const turn = {
      cancelRequested: false,
      cancelTask: null,
      finished: false,
      input: text,
      projectRoot: workspaceDirectory,
      requestId,
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      state: "submitting",
      streamedReplyContent: "",
      text: "",
      toolNames: new Set(),
      usageTasks: [],
      userText: text,
    };
    const active = [...activeTurns.values()][0] || null;
    const steering = Boolean(active || pendingTurns.length);
    if (steering) {
      // Match the normal chat: a direct follow-up becomes the next turn and
      // interrupts the current one as soon as Agent Core reports it running.
      pendingTurns.unshift(turn);
      if (active && !active.finished) {
        active.cancelRequested = true;
        void requestCancellation(active);
      }
      void pumpTurns();
      return Object.freeze({
        accepted: true,
        queued: true,
        requestId,
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        steering: true,
      });
    }
    try {
      await submitTurn(turn);
      return Object.freeze({
        accepted: true,
        queued: false,
        requestId,
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        steering: false,
      });
    } catch (error) {
      throw new SoftwareAssistantServiceError(`无法发送给软件助手：${errorMessage(error, "未知错误。")}`, {
        cause: error,
        code: clean(error?.code) || "SEND_FAILED",
      });
    }
  };

  const stop = async ({ requestId = "" } = {}) => {
    const requested = clean(requestId);
    const queuedIndex = requested ? pendingTurns.findIndex((item) => item.requestId === requested) : -1;
    if (queuedIndex >= 0) {
      const [queued] = pendingTurns.splice(queuedIndex, 1);
      emit({ type: "turn-stopped", requestId: queued.requestId, message: "已从等待中的引导里移除。" });
      return { accepted: true, stopped: true, requestId: queued.requestId };
    }
    const turn = requested ? activeTurns.get(requested) : [...activeTurns.values()][0];
    if (!turn || turn.finished) return { accepted: true, stopped: false, message: "当前没有正在处理的问题。" };
    turn.cancelRequested = true;
    await requestCancellation(turn);
    return { accepted: true, stopped: true, requestId: turn.requestId };
  };

  // The product helper uses one fixed session. Keep its workspace while
  // clearing the native Agent Core transcript before the next question.
  const clearHistory = async () => {
    if (disposed) throw new SoftwareAssistantServiceError("软件助手已经停止。", { code: "SERVICE_STOPPED" });
    if (activeTurns.size || pendingTurns.length) {
      throw new SoftwareAssistantServiceError("Suzu 正在处理当前问题，请结束后再清空记录。", { code: "TURN_ACTIVE" });
    }
    try {
      await runtime.purgeSession({
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        cwd: workspaceDirectory,
        imageAttachmentIds: [],
        protectedImageAttachmentIds: [],
      });
    } catch (error) {
      throw new SoftwareAssistantServiceError(
        `无法清空问 Suzu 的记录：${errorMessage(error, "未知错误。")}`,
        { cause: error, code: clean(error?.code) || "CLEAR_HISTORY_FAILED" },
      );
    }
    emit({ type: "history-cleared" });
    return Object.freeze({
      accepted: true,
      cleared: true,
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    });
  };

  return Object.freeze({
    clearHistory,
    snapshot,
    send,
    stop,
    subscribe(listener) {
      if (typeof listener !== "function") throw new SoftwareAssistantServiceError("软件助手订阅者无效。", { code: "INVALID_LISTENER" });
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { unsubscribeRuntime?.(); } catch { /* Shared Agent Core runtime closes elsewhere. */ }
      activeTurns.clear();
      pendingTurns.splice(0);
      subscribers.clear();
      return true;
    },
  });
}
