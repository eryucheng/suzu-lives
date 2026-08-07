import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const MAX_MESSAGE_LENGTH = 20_000;
const MAX_EVENT_TEXT_LENGTH = 200_000;
const MAX_PERMISSION_PREVIEW_LENGTH = 4_000;
const MAX_QUEUED_TURNS = 50;
const MAX_AGENT_MEDIA_ITEMS = 24;
const MAX_AGENT_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_INBOUND_MEDIA_ITEMS = 24;
const MAX_INBOUND_MEDIA_BYTES = 50 * 1024 * 1024;
const CONVERSATION_ATTACHMENT_RECEIPT = "suzu-conversation-attachment";
const WECHAT_MEDIA_MANIFEST_OPEN = "<suzu-wechat-media>";
const WECHAT_MEDIA_MANIFEST_CLOSE = "</suzu-wechat-media>";
const CLAUDE_RUNTIME_FEATURE_DEFAULTS = Object.freeze({
  subagents: false,
  taskList: false,
  backgroundTasks: false,
  nativeCron: false,
  askUserQuestion: false,
});

export class ConversationChatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationChatError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeClaudeRuntimeFeatures(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...CLAUDE_RUNTIME_FEATURE_DEFAULTS,
    subagents: source.subagents === true,
    taskList: source.taskList === true,
    backgroundTasks: source.backgroundTasks === true,
    nativeCron: source.nativeCron === true,
    askUserQuestion: source.askUserQuestion === true,
  };
}

function bounded(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text;
}

function messageText(content) {
  if (typeof content === "string") return bounded(content, MAX_EVENT_TEXT_LENGTH);
  if (!Array.isArray(content)) return "";
  return bounded(content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n"), MAX_EVENT_TEXT_LENGTH);
}

function serializedText(value) {
  if (typeof value === "string") return bounded(value, MAX_EVENT_TEXT_LENGTH);
  try { return bounded(JSON.stringify(value ?? {}, null, 2), MAX_EVENT_TEXT_LENGTH); }
  catch { return "[无法展示内容]"; }
}

function toolSummary(input) {
  const source = input && typeof input === "object" ? input : {};
  return clean(source.command || source.file_path || source.path || source.description || source.query || "");
}

function auxiliaryParts(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const type = clean(part?.type);
    if (type === "thinking") {
      const text = bounded(part.thinking ?? part.text ?? "", MAX_EVENT_TEXT_LENGTH);
      return text ? [{ type: "thinking", content: text }] : [];
    }
    if (type === "tool_use") {
      const name = clean(part.name) || "工具";
      const summary = toolSummary(part.input);
      return [{ type: "tool", content: `Claude Code 工具调用：${name}${summary ? `\n${summary}` : ""}` }];
    }
    if (type === "tool_result") {
      const detail = serializedText(part.content);
      return [{ type: "tool", content: `Claude Code 工具结果${part.is_error ? "（错误）" : ""}${detail ? `：\n${detail}` : ""}` }];
    }
    return [];
  });
}

function usageSummary(usage, model = "") {
  const source = usage && typeof usage === "object" ? usage : null;
  if (!source) return "";
  const token = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const values = [
    ["输入", token(source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? source.promptTokens)],
    ["缓存写入", token(source.cache_creation_input_tokens ?? source.cacheCreationInputTokens ?? source.cache_write_tokens ?? source.cacheWriteTokens)],
    ["缓存读取", token(source.cache_read_input_tokens ?? source.cacheReadInputTokens ?? source.cached_tokens ?? source.cachedTokens)],
    ["输出", token(source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? source.completionTokens)],
  ].filter(([, value]) => value !== null);
  if (!values.length) return "";
  const total = values.reduce((sum, [, value]) => sum + value, 0);
  return `${clean(model || source.model) ? `${clean(model || source.model)} · ` : ""}${values.map(([label, value]) => `${label} ${value.toLocaleString("zh-CN")}`).join(" · ")} · 合计 ${total.toLocaleString("zh-CN")}`;
}

function mergeFullText(previous, next) {
  if (!next) return previous;
  if (!previous || next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  return next;
}

function permissionPreview(input) {
  try {
    return bounded(JSON.stringify(input ?? {}, null, 2), MAX_PERMISSION_PREVIEW_LENGTH);
  } catch {
    return "[无法展示工具参数]";
  }
}

function processErrorMessage(error, fallback) {
  return clean(error?.message || error) || fallback;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parsedObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = clean(value);
  if (!source) return null;
  const candidates = [source];
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Non-JSON tool output is not an attachment receipt. */ }
  }
  return null;
}

function normalizeAgentMediaReceipt(value) {
  const source = plainObject(parsedObject(value));
  if (source.status !== "ok" || clean(source.type) !== CONVERSATION_ATTACHMENT_RECEIPT) return null;
  const receiptId = clean(source.receiptId).slice(0, 160);
  const media = (Array.isArray(source.items) ? source.items : []).slice(0, MAX_AGENT_MEDIA_ITEMS).flatMap((item) => {
    const entry = plainObject(item);
    const kind = clean(entry.kind).toLowerCase();
    const sourcePath = clean(entry.path);
    const size = Number(entry.size);
    if (!new Set(["image", "audio", "file"]).has(kind) || !sourcePath || !path.isAbsolute(sourcePath)) return [];
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_AGENT_MEDIA_BYTES) return [];
    const resolved = path.resolve(sourcePath);
    return [{
      kind,
      path: resolved,
      fileName: clean(entry.fileName) || path.basename(resolved),
      size,
    }];
  });
  return media.length ? { receiptId, media } : null;
}

function attachmentReceiptsFromToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (clean(part?.type) !== "tool_result" || part?.is_error === true) return [];
    const source = part.content;
    if (Array.isArray(source)) {
      return source.flatMap((item) => normalizeAgentMediaReceipt(item?.text ?? item?.content ?? item));
    }
    const receipt = normalizeAgentMediaReceipt(source);
    return receipt ? [receipt] : [];
  });
}

function isDirectory(stat) {
  return Boolean(stat?.isDirectory?.());
}

function sameProjectRoot(left, right) {
  const first = clean(left);
  const second = clean(right);
  if (!first || !second) return false;
  const normalizedLeft = path.resolve(first);
  const normalizedRight = path.resolve(second);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function turnKey(sessionId, projectRoot) {
  const id = clean(sessionId);
  const root = clean(projectRoot);
  if (!id || !root) throw new ConversationChatError("指定 Claude 会话时必须同时提供会话标识和工作目录。");
  const normalizedRoot = path.resolve(root);
  const stableRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  return `${stableRoot}\u0000${id}`;
}

async function existingFile(fsOps, filePath) {
  try {
    return (await fsOps.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function writeJson(child, value) {
  if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    throw new ConversationChatError("Claude Code 进程已经不可写入。");
  }
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function inboundMediaFileName(value, fallback) {
  const name = path.basename(clean(value)).replace(/[\r\n]/gu, "").slice(0, 300);
  return name || fallback;
}

function normalizeInboundMedia(value, mediaSource = "wechat") {
  const items = Array.isArray(value) ? value : [];
  const source = clean(mediaSource).toLowerCase();
  if (!new Set(["wechat", "iphone"]).has(source)) throw new ConversationChatError("会话附件来源无效。");
  if (items.length > MAX_INBOUND_MEDIA_ITEMS) {
    throw new ConversationChatError(`单条会话消息最多包含 ${MAX_INBOUND_MEDIA_ITEMS} 个附件。`);
  }
  return items.map((entry, index) => {
    const source = plainObject(entry);
    const kind = clean(source.kind).toLowerCase();
    if (!new Set(["image", "file"]).has(kind)) throw new ConversationChatError("会话附件类型无效。");
    const sourcePath = clean(source.path);
    if (!sourcePath || !path.isAbsolute(sourcePath)) throw new ConversationChatError("会话附件缓存路径无效。");
    const data = Buffer.isBuffer(source.data) ? source.data : Buffer.from(source.data || []);
    if (!data.length || data.length > MAX_INBOUND_MEDIA_BYTES) {
      throw new ConversationChatError(`会话附件大小必须在 1 B 到 ${MAX_INBOUND_MEDIA_BYTES >> 20} MiB 之间。`);
    }
    return {
      kind,
      path: path.resolve(sourcePath),
      fileName: inboundMediaFileName(source.fileName, `${kind}-${index + 1}`),
      mimeType: clean(source.mimeType) || (kind === "image" ? "image/jpeg" : "application/octet-stream"),
      size: data.length,
      data,
    };
  });
}

function wechatMediaManifest(media, mediaSource = "wechat") {
  const source = clean(mediaSource).toLowerCase();
  const label = source === "iphone" ? "iPhone 反馈带来的附件" : "微信发来的附件";
  return `${WECHAT_MEDIA_MANIFEST_OPEN}${JSON.stringify({
    source,
    instruction: `${label}。图片已经随消息附上；需要读取文件时，请使用下面的本地路径。`,
    items: media.map((item) => ({
      kind: item.kind,
      path: item.path,
      fileName: item.fileName,
      size: item.size,
    })),
  })}${WECHAT_MEDIA_MANIFEST_CLOSE}`;
}

function claudeInputContent(text, media, mediaSource = "wechat") {
  if (!media.length) return text;
  const parts = media
    .filter((item) => item.kind === "image")
    .map((item) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: item.mimeType,
        data: item.data.toString("base64"),
      },
    }));
  const content = [text, wechatMediaManifest(media, mediaSource)].filter(Boolean).join("\n\n");
  parts.push({ type: "text", text: content });
  return parts;
}

export function wechatAttachmentSystemPrompt(command) {
  const launcher = clean(command);
  if (!launcher) return "";
  return `## Suzu 附件交付
生成本机图片、MP3 音频或文件后需要交付给用户时，直接执行下面的命令。文件会作为当前 Suzu 会话中的附件显示；如果这个会话已经绑定微信，Suzu 会自动额外投递到它对应的微信，无需指定微信号。

${launcher} --image "图片的绝对路径"
${launcher} --audio "MP3 音频的绝对路径"
${launcher} --file "文件的绝对路径"

可重复使用 --image、--audio 或 --file。普通文字仍直接正常回复，不要用这个命令发送普通文字。
`;
}

export function scheduleSystemPrompt(commands) {
  const conversationAdd = clean(commands?.conversationAdd);
  const operationAdd = clean(commands?.operationAdd);
  const list = clean(commands?.list);
  const remove = clean(commands?.remove);
  const chainPrompt = clean(commands?.proactiveChainPrompt) || "根据时间和前面聊的内容判断要不要主动联系对方，要发就正常发，不发就沉默，然后记得要设置下一次自动任务";
  const followUpPrompt = clean(commands?.proactiveFollowUpPrompt) || "临时回访：用户在 TIME 提到 EVENT。先检查当前会话里是否已经有结果；已经有结果就只输出 NO_REPLY；还没有结果就自然地关心或询问。不要提及自动任务、回访任务或系统机制。这是一次性回访，不要设置下一次自动任务。";
  if (!conversationAdd && !operationAdd) return "";
  const sections = ["## Suzu 自动任务", "任务只会在 Suzu 软件运行期间执行；关闭期间不会执行或补跑。不要使用旧的 timer 或 cron 命令。"];
  if (conversationAdd) {
    sections.push(`### 主动关心\n\n当前会话已在“主动关心”能力中启用。一次性任务会自动绑定当前 Claude 会话和项目：\n\n${conversationAdd} --delay 45m --prompt "到时间后要处理的完整任务内容" --desc "简短说明"\n\n链式主动关心触发时使用这段提示词：\n\n${chainPrompt}\n\n临时回访使用这段提示词：\n\n${followUpPrompt}`);
  }
  if (operationAdd) {
    sections.push(`### 远行商人\n\n至少有一个会话已在“远行商人”能力中启用。循环任务由 Suzu 抓取一次网页，并把命中结果分别投递到那些已启用会话：\n\n${operationAdd} --cron "2 8,12,16,20 * * *" --exec traveling-merchant --desc "洛克王国远行商人监控"`);
  }
  if (list && remove) {
    sections.push(`### 查看与删除\n\n${list}\n${remove}`);
  }
  sections.push("--delay 使用 s、m、h 或 d，例如 45m。任务触发后，它不是用户的新消息；如无需对用户可见的回复，只输出精确的 NO_REPLY。");
  return sections.join("\n\n");
}

function isNoReply(value) {
  return clean(value) === "NO_REPLY";
}

/** The flags are deliberately limited to Claude Code's public stream protocol. */
export function claudeCliArguments({ sessionId, hasTranscript = false, appendSystemPrompt = "", claudeRuntimeFeatures } = {}) {
  const id = clean(sessionId);
  if (!id) throw new ConversationChatError("缺少 Claude 会话标识。");
  const extraPrompt = clean(appendSystemPrompt);
  const features = normalizeClaudeRuntimeFeatures(claudeRuntimeFeatures);
  const disallowedTools = [
    !features.subagents && "Agent",
    !features.taskList && "TodoWrite",
    !features.askUserQuestion && "AskUserQuestion",
  ].filter(Boolean);
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--replay-user-messages",
    ...(disallowedTools.length ? ["--disallowed-tools", disallowedTools.join(",")] : []),
    ...(extraPrompt ? ["--append-system-prompt", extraPrompt] : []),
    ...(hasTranscript ? ["--resume", id] : ["--session-id", id]),
  ];
}

export function claudeCliEnvironment({ claudeRuntimeFeatures, baseEnv = process.env } = {}) {
  const features = normalizeClaudeRuntimeFeatures(claudeRuntimeFeatures);
  const environment = baseEnv && typeof baseEnv === "object" ? baseEnv : {};
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    if (["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_DISABLE_CRON"].includes(key.toUpperCase())) delete next[key];
  }
  if (!features.backgroundTasks) next.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  if (!features.nativeCron) next.CLAUDE_CODE_DISABLE_CRON = "1";
  return next;
}

export async function resolveClaudeCommand({
  fsOps = fs,
  homeDirectory = os.homedir(),
  platform = process.platform,
} = {}) {
  const executable = platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    path.join(homeDirectory, ".local", "bin", executable),
    path.join(homeDirectory, ".local", "bin", "claude"),
  ];
  for (const candidate of candidates) {
    if (await existingFile(fsOps, candidate)) return candidate;
  }
  return executable;
}

export function createConversationChatService({
  settingsService,
  reader,
  fsOps = fs,
  homeDirectory = os.homedir(),
  agentAttachmentCommand = null,
  agentScheduleCommand = null,
  spawnImpl = spawn,
  onEvent = () => {},
} = {}) {
  if (!settingsService?.load) throw new ConversationChatError("会话聊天需要软件设置服务。");
  if (!reader?.ensureActiveSession) throw new ConversationChatError("会话聊天需要原生 Claude 会话读取服务。");

  let eventSink = typeof onEvent === "function" ? onEvent : () => {};
  const eventSubscribers = new Set();
  const emit = (payload) => {
    try { eventSink(payload); } catch { /* A UI listener must not affect the local Claude process. */ }
    for (const listener of eventSubscribers) {
      try { listener(payload); } catch { /* A secondary transport must not affect the local Claude process. */ }
    }
  };
  const activeTurns = new Map();
  const knownTranscripts = new Set();
  const pendingTurns = new Map();
  const permissionRequests = new Map();
  const startingSessions = new Set();
  let disposed = false;

  const queueFor = (sessionId, projectRoot) => {
    const key = turnKey(sessionId, projectRoot);
    let queue = pendingTurns.get(key);
    if (!queue) {
      queue = [];
      pendingTurns.set(key, queue);
    }
    return queue;
  };

  const emitQueue = (sessionId, projectRoot = "") => {
    const queue = pendingTurns.get(turnKey(sessionId, projectRoot)) || [];
    emit({
      type: "queue",
      sessionId,
      projectRoot: clean(projectRoot),
      items: queue.map((item, index) => ({
        requestId: item.requestId,
        position: index + 1,
        kind: item.kind,
      })),
      timestamp: new Date().toISOString(),
    });
  };

  const removePermissionRequests = (turn) => {
    for (const requestId of turn.permissionIds) permissionRequests.delete(requestId);
    turn.permissionIds.clear();
  };

  const finishTurn = (turn, { error = "", interrupted = false } = {}) => {
    if (turn.finished) return;
    turn.finished = true;
    activeTurns.delete(turn.key);
    removePermissionRequests(turn);
    if (interrupted) {
      emit({
        type: "turn-stopped",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        message: turn.interruptMessage || "已停止当前 Claude Code 任务。",
        timestamp: new Date().toISOString(),
      });
    } else if (error) {
      emit({
        type: "error",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        message: error,
        timestamp: new Date().toISOString(),
      });
    } else {
      emit({
        type: "turn-complete",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        timestamp: new Date().toISOString(),
      });
    }
    void pumpSession(turn.sessionId, turn.projectRoot);
  };

  const emitReply = (turn, type, done = false) => {
    if (!turn.text) return;
    emit({
      type,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      content: turn.text,
      done,
      timestamp: new Date().toISOString(),
    });
  };

  const emitAgentReply = (turn, content) => {
    const text = clean(content);
    if (!text) return;
    emit({
      type: "agent-reply",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      content: text,
      timestamp: new Date().toISOString(),
    });
  };

  const emitCompletedReply = (turn) => {
    if (!turn.text || (turn.kind === "schedule" && isNoReply(turn.text))) return;
    if (turn.kind === "schedule") emitAgentReply(turn, turn.text);
    emitReply(turn, "reply", true);
  };

  const emitAuxiliary = (turn, type, content) => {
    const text = clean(content);
    if (!text) return;
    const key = `${type}\u0000${text}`;
    if (turn.auxiliaryEvents.has(key)) return;
    turn.auxiliaryEvents.add(key);
    if (turn.auxiliaryEvents.size > 240) turn.auxiliaryEvents.delete(turn.auxiliaryEvents.values().next().value);
    emit({
      type,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      content: text,
      timestamp: new Date().toISOString(),
    });
  };

  const emitAgentMedia = (turn, receipts) => {
    for (const receipt of receipts) {
      const source = plainObject(receipt);
      const media = Array.isArray(source.media) ? source.media : [];
      if (!media.length) continue;
      const key = clean(source.receiptId) || media.map((item) => `${item.kind}\u0000${item.path}\u0000${item.size}`).join("\u0001");
      if (!key || turn.agentMediaReceipts.has(key)) continue;
      turn.agentMediaReceipts.add(key);
      emit({
        type: "agent-media",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        media,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const handleWireMessage = (turn, raw) => {
    if (turn.interrupted) return;
    const type = clean(raw?.type);
    if (type === "system" && raw?.subtype === "init") {
      const commands = Array.isArray(raw?.slash_commands)
        ? raw.slash_commands.map((item) => clean(typeof item === "string" ? item : item?.name)).filter(Boolean)
        : [];
      emit({
        type: "slash-commands",
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        commands,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (type === "system") {
      emitAuxiliary(turn, "system", raw?.content ?? raw?.message?.content ?? (raw?.subtype ? `[系统: ${raw.subtype}]` : ""));
      return;
    }
    if (type === "assistant") {
      emitAgentMedia(turn, attachmentReceiptsFromToolResults(raw?.message?.content));
      for (const item of auxiliaryParts(raw?.message?.content)) emitAuxiliary(turn, item.type, item.content);
      const next = messageText(raw?.message?.content);
      if (next) {
        turn.text = mergeFullText(turn.text, next);
        turn.lastAssistantText = next;
        if (turn.kind !== "schedule") {
          emitAgentReply(turn, next);
          emitReply(turn, "reply-stream");
        }
      }
      return;
    }
    if (type === "user") {
      emitAgentMedia(turn, attachmentReceiptsFromToolResults(raw?.message?.content));
      for (const item of auxiliaryParts(raw?.message?.content)) emitAuxiliary(turn, item.type, item.content);
      return;
    }
    if (type === "attachment" || type === "hook_additional_context") {
      const attachment = raw?.attachment && typeof raw.attachment === "object" ? raw.attachment : raw;
      const content = Array.isArray(attachment.content) ? attachment.content.join("\n") : attachment.content;
      emitAuxiliary(turn, "attachment", content);
      return;
    }
    if (type === "stream_event") {
      const delta = raw?.event?.delta?.text ?? raw?.delta?.text;
      if (typeof delta === "string" && delta) {
        turn.text = bounded(`${turn.text}${delta}`, MAX_EVENT_TEXT_LENGTH);
        if (turn.kind !== "schedule") emitReply(turn, "reply-stream");
      }
      return;
    }
    if (type === "control_request") {
      const requestId = clean(raw?.request_id);
      const request = raw?.request && typeof raw.request === "object" ? raw.request : {};
      if (!requestId || request.subtype !== "can_use_tool") return;
      const permission = {
        requestId,
        turn,
        input: request.input && typeof request.input === "object" ? request.input : {},
      };
      turn.permissionIds.add(requestId);
      permissionRequests.set(requestId, permission);
      emit({
        type: "permission",
        requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        toolName: clean(request.tool_name) || "Claude Code 工具",
        preview: permissionPreview(permission.input),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (type !== "result" || raw?.subtype === "compact" || raw?.subtype === "compaction") return;
    const result = typeof raw?.result === "string" ? bounded(raw.result, MAX_EVENT_TEXT_LENGTH) : "";
    if (result) {
      turn.text = mergeFullText(turn.text, result);
      if (turn.kind !== "schedule" && clean(result) !== clean(turn.lastAssistantText)) emitAgentReply(turn, result);
    }
    emitAuxiliary(turn, "usage", usageSummary(raw?.usage ?? raw?.message?.usage, raw?.model ?? raw?.message?.model));
    turn.completed = true;
    turn.resultError = raw?.is_error === true ? clean(raw?.result) || "Claude Code 没有完成这次回复。" : "";
    emitCompletedReply(turn);
    try { turn.child.stdin?.end(); } catch { /* Closing after a final result is best effort. */ }
  };

  const validateContent = (value, { allowEmpty = false } = {}) => {
    const text = String(value ?? "").trim();
    if (!text && !allowEmpty) throw new ConversationChatError("消息不能为空。");
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new ConversationChatError(`消息不能超过 ${MAX_MESSAGE_LENGTH.toLocaleString("zh-CN")} 个字符。`);
    }
    return text;
  };

  const startTurn = async (request) => {
    if (disposed) return;
    let projectStat;
    try { projectStat = await fsOps.stat(request.projectRoot); }
    catch { throw new ConversationChatError("当前 Claude 工作目录不存在或无法读取。"); }
    if (!isDirectory(projectStat)) throw new ConversationChatError("当前 Claude 工作目录不是文件夹。");

    const command = await resolveClaudeCommand({ fsOps, homeDirectory });
    if (disposed) return;
    const attachmentCommand = typeof agentAttachmentCommand === "function"
      ? agentAttachmentCommand({ sessionId: request.sessionId, projectRoot: request.projectRoot })
      : "";
    const scheduleCommands = typeof agentScheduleCommand === "function"
      ? agentScheduleCommand({ sessionId: request.sessionId, projectRoot: request.projectRoot })
      : null;
    const claudeRuntimeFeatures = settingsService.load()?.claudeRuntimeFeatures;
    const args = claudeCliArguments({
      sessionId: request.sessionId,
      hasTranscript: request.hasTranscript || knownTranscripts.has(request.key),
      claudeRuntimeFeatures,
      appendSystemPrompt: [
        wechatAttachmentSystemPrompt(attachmentCommand),
        scheduleSystemPrompt(scheduleCommands),
      ].filter(Boolean).join("\n\n"),
    });
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: request.projectRoot,
        env: claudeCliEnvironment({ claudeRuntimeFeatures }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new ConversationChatError(`无法启动本机 Claude Code：${processErrorMessage(error, "启动失败。")}`);
    }
    if (!child?.stdin || !child?.stdout) {
      try { child?.kill?.(); } catch { /* The process may not have started. */ }
      throw new ConversationChatError("无法建立 Claude Code 的本地输入输出通道。");
    }

    const turn = {
      agentMediaReceipts: new Set(),
      auxiliaryEvents: new Set(),
      child,
      completed: false,
      finished: false,
      interrupted: false,
      kind: request.kind,
      lastAssistantText: "",
      key: request.key,
      permissionIds: new Set(),
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      resultError: "",
      sessionId: request.sessionId,
      stderr: "",
      text: "",
    };
    activeTurns.set(request.key, turn);
    emit({
      type: "turn-start",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      timestamp: new Date().toISOString(),
    });
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      handleWireMessage(turn, raw);
    });
    child.stderr?.on?.("data", (chunk) => {
      turn.stderr = bounded(`${turn.stderr}${String(chunk)}`, 6_000);
    });
    child.on?.("error", (error) => {
      finishTurn(turn, turn.interrupted
        ? { interrupted: true }
        : { error: `无法运行本机 Claude Code：${processErrorMessage(error, "进程启动失败。")}` });
    });
    child.on?.("close", (code, signal) => {
      output.close();
      if (turn.finished) return;
      if (turn.interrupted) {
        finishTurn(turn, { interrupted: true });
        return;
      }
      if (turn.completed || code === 0) {
        if (!turn.completed) {
          if (turn.kind !== "schedule" && turn.text && clean(turn.text) !== clean(turn.lastAssistantText)) emitAgentReply(turn, turn.text);
          emitCompletedReply(turn);
        }
        finishTurn(turn, { error: turn.resultError });
        return;
      }
      const detail = clean(turn.stderr).replace(/\s+/gu, " ");
      const reason = signal
        ? `Claude Code 已停止（${signal}）。`
        : `Claude Code 未能完成这次回复（退出代码 ${code ?? "未知"}）。`;
      finishTurn(turn, { error: detail ? `${reason} ${detail}` : reason });
    });
    try {
      writeJson(child, { type: "user", message: { role: "user", content: request.content } });
      knownTranscripts.add(request.key);
    } catch (error) {
      finishTurn(turn, { error: processErrorMessage(error, "无法向 Claude Code 发送消息。") });
      try { child.kill?.(); } catch { /* The error is already emitted to the conversation. */ }
    }
  };

  const pumpSession = async (sessionId, projectRoot, { propagateStartError = false } = {}) => {
    const key = turnKey(sessionId, projectRoot);
    if (disposed || activeTurns.has(key) || startingSessions.has(key)) return;
    const queue = pendingTurns.get(key);
    if (!queue?.length) return;
    const request = queue.shift();
    if (!queue.length) pendingTurns.delete(key);
    emitQueue(sessionId, request.projectRoot);
    startingSessions.add(key);
    try {
      await startTurn(request);
    } catch (error) {
      if (propagateStartError) throw error;
      emit({
        type: "error",
        requestId: request.requestId,
        sessionId,
        projectRoot: request.projectRoot,
        kind: request.kind,
        message: processErrorMessage(error, "无法启动本机 Claude Code。"),
        timestamp: new Date().toISOString(),
      });
    } finally {
      startingSessions.delete(key);
      if (!disposed && !activeTurns.has(key)) void pumpSession(sessionId, projectRoot);
    }
  };

  const resolveSession = async ({ sessionId, projectRoot, hasTranscript } = {}) => {
    const id = clean(sessionId);
    const root = clean(projectRoot);
    if (!id && !root) return reader.ensureActiveSession();
    if (!id || !root) throw new ConversationChatError("指定 Claude 会话时必须同时提供会话标识和工作目录。");
    return { id, projectRoot: root, hasTranscript: hasTranscript === true };
  };

  const enqueue = async ({ content, kind = "message", media: suppliedMedia = [], mediaSource = "wechat", session: requestedSession = null } = {}) => {
    if (disposed) throw new ConversationChatError("聊天服务已经停止。");
    const media = normalizeInboundMedia(suppliedMedia, mediaSource);
    const text = validateContent(content, { allowEmpty: media.length > 0 });
    const session = await resolveSession(requestedSession || {});
    if (!session?.id || !session.projectRoot) throw new ConversationChatError("请先选择 Claude 工作目录。");
    let projectStat;
    try { projectStat = await fsOps.stat(session.projectRoot); }
    catch { throw new ConversationChatError("当前 Claude 工作目录不存在或无法读取。"); }
    if (!isDirectory(projectStat)) throw new ConversationChatError("当前 Claude 工作目录不是文件夹。");

    const request = {
      content: claudeInputContent(text, media, mediaSource),
      hasTranscript: Boolean(session.hasTranscript) || knownTranscripts.has(turnKey(session.id, session.projectRoot)),
      kind,
      key: turnKey(session.id, session.projectRoot),
      projectRoot: session.projectRoot,
      requestId: `suzu-${randomUUID()}`,
      sessionId: session.id,
    };
    const queue = queueFor(session.id, session.projectRoot);
    if (queue.length >= MAX_QUEUED_TURNS) {
      throw new ConversationChatError(`当前会话最多只能排队 ${MAX_QUEUED_TURNS} 条消息，请等待部分任务完成后再发送。`);
    }
    const queued = activeTurns.has(request.key) || startingSessions.has(request.key) || queue.length > 0;
    queue.push(request);
    const queuePosition = queue.indexOf(request) + 1;
    emitQueue(session.id, session.projectRoot);
    const pumping = pumpSession(session.id, session.projectRoot, { propagateStartError: !queued });
    if (!queued) await pumping;
    return {
      accepted: true,
      queued,
      queuePosition,
      requestId: request.requestId,
      sessionId: request.sessionId,
    };
  };

  const interruptTurn = (turn, message) => {
    if (!turn || turn.finished) return false;
    turn.interrupted = true;
    turn.interruptMessage = message;
    try {
      const killed = turn.child.kill?.("SIGTERM");
      if (killed === false) throw new Error("Claude Code 进程已经结束。");
    } catch (error) {
      turn.interrupted = false;
      turn.interruptMessage = "";
      throw new ConversationChatError(`无法停止当前 Claude Code 任务：${processErrorMessage(error, "停止失败。")}`);
    }
    return true;
  };

  const send = ({ content } = {}) => enqueue({ content });
  const sendToSession = ({ content, sessionId, projectRoot, hasTranscript = false, kind = "message", media = [], mediaSource = "wechat" } = {}) => (
    enqueue({ content, kind, media, mediaSource, session: { sessionId, projectRoot, hasTranscript } })
  );

  const stop = ({ sessionId, projectRoot } = {}) => {
    const id = clean(sessionId);
    if (!id) throw new ConversationChatError("缺少要停止的 Claude 会话标识。");
    const root = clean(projectRoot);
    const matches = root
      ? [activeTurns.get(turnKey(id, root))].filter(Boolean)
      : [...activeTurns.values()].filter((item) => item.sessionId === id);
    if (matches.length > 1) throw new ConversationChatError("同名 Claude 会话正在多个工作目录中运行，请从对应会话里停止。 ");
    const turn = matches[0];
    if (!turn) {
      return { accepted: true, stopped: false, sessionId: id, message: "当前会话没有正在执行的 Claude Code 任务。" };
    }
    interruptTurn(turn, "已停止当前 Claude Code 任务。");
    return { accepted: true, stopped: true, sessionId: id, message: "正在停止当前 Claude Code 任务。" };
  };

  const steer = async ({ content, sessionId, projectRoot, hasTranscript = false } = {}) => {
    if (disposed) throw new ConversationChatError("聊天服务已经停止。");
    const text = validateContent(content);
    const session = await resolveSession({ sessionId, projectRoot, hasTranscript });
    if (!session?.id || !session.projectRoot) throw new ConversationChatError("请先选择 Claude 工作目录。");
    const turn = activeTurns.get(turnKey(session.id, session.projectRoot));
    if (!turn || turn.completed || turn.interrupted) {
      const request = await enqueue({ content: text, kind: "steer", session });
      return { ...request, delivered: false, message: "当前没有运行中的任务，已作为一条新消息发送。" };
    }
    try {
      writeJson(turn.child, { type: "user", message: { role: "user", content: text } });
    } catch (error) {
      throw new ConversationChatError(`无法发送引导消息：${processErrorMessage(error, "Claude Code 当前不可写入。")}`);
    }
    return {
      accepted: true,
      delivered: true,
      queued: false,
      requestId: `suzu-${randomUUID()}`,
      sessionId: session.id,
      message: "引导已送达；Claude 会在当前动作完成后读取并调整下一步。",
    };
  };

  const respondPermission = ({ requestId, behavior } = {}) => {
    const id = clean(requestId);
    const permission = permissionRequests.get(id);
    if (!permission || permission.turn.finished) throw new ConversationChatError("这条 Claude Code 权限请求已经失效。");
    const allow = behavior === "allow";
    writeJson(permission.turn.child, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: allow
          ? { behavior: "allow", updatedInput: permission.input }
          : { behavior: "deny", message: "The user denied this tool use. Stop and wait for the user's instructions." },
      },
    });
    permissionRequests.delete(id);
    permission.turn.permissionIds.delete(id);
    return { accepted: true, requestId: id, behavior: allow ? "allow" : "deny" };
  };

  const dispose = () => {
    disposed = true;
    pendingTurns.clear();
    startingSessions.clear();
    for (const turn of activeTurns.values()) {
      turn.finished = true;
      removePermissionRequests(turn);
      try { turn.child.kill?.(); } catch { /* Only processes created by this service are touched. */ }
    }
    activeTurns.clear();
    permissionRequests.clear();
  };

  return {
    dispose,
    respondPermission,
    send,
    sendToSession,
    setEventSink: (callback) => { eventSink = typeof callback === "function" ? callback : () => {}; },
    subscribe: (callback) => {
      if (typeof callback !== "function") return () => {};
      eventSubscribers.add(callback);
      return () => eventSubscribers.delete(callback);
    },
    steer,
    stop,
  };
}
