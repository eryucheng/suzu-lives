import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { DEFAULT_CLAUDE_PERMISSION_MODE, normalizeClaudePermissionMode } from "./claude-permission-mode.mjs";

const MAX_MESSAGE_LENGTH = 20_000;
const MAX_EVENT_TEXT_LENGTH = 200_000;
const MAX_PERMISSION_PREVIEW_LENGTH = 4_000;
const MAX_QUEUED_TURNS = 50;
const MAX_AGENT_MEDIA_ITEMS = 24;
const MAX_AGENT_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_INBOUND_MEDIA_ITEMS = 24;
const MAX_INBOUND_MEDIA_BYTES = 50 * 1024 * 1024;
const TEXT_STREAM_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const TEXT_STREAM_CLOSE_GRACE_MS = 5_000;
const VOICE_CALL_TURN_OPEN = "<suzu-voice-call-turn>";
const VOICE_CALL_TURN_CLOSE = "</suzu-voice-call-turn>";
const VOICE_CALL_OPEN_OPEN = "<suzu-voice-call-open>";
const VOICE_CALL_OPEN_CLOSE = "</suzu-voice-call-open>";
const LONG_TERM_MEMORY_CONTEXT_OPEN = "<suzu-long-term-memory>";
const LONG_TERM_MEMORY_CONTEXT_CLOSE = "</suzu-long-term-memory>";
const CONVERSATION_ATTACHMENT_RECEIPT = "suzu-conversation-attachment";
const VOICE_CALL_REQUEST_RECEIPT = "suzu-voice-call-request";
const WECHAT_MEDIA_MANIFEST_OPEN = "<suzu-wechat-media>";
const WECHAT_MEDIA_MANIFEST_CLOSE = "</suzu-wechat-media>";
const STICKER_MEDIA_MANIFEST_OPEN = "<suzu-sticker>";
const STICKER_MEDIA_MANIFEST_CLOSE = "</suzu-sticker>";
const CLAUDE_RUNTIME_FEATURE_DEFAULTS = Object.freeze({
  bash: true,
  edit: true,
  glob: true,
  grep: true,
  subagents: false,
  taskList: false,
  backgroundTasks: false,
  nativeCron: false,
  askUserQuestion: false,
  write: true,
});
const VOICE_CALL_SYSTEM_PROMPT = [
  `Suzu 会把实时语音通话的一轮输入包装为 ${VOICE_CALL_TURN_OPEN}JSON${VOICE_CALL_TURN_CLOSE}。`,
  "仅在收到这个标记时，读取 JSON 中的 transcript 作为用户本轮说的话；用自然、口语化、简短的中文回答，先给一两句可以独立朗读的短句。",
  `电话真正接通时，Suzu 会发送 ${VOICE_CALL_OPEN_OPEN}JSON${VOICE_CALL_OPEN_CLOSE}。这不是用户说的话；JSON 的 initiator 是本次通话请求方（agent 或 user）。收到它时只用一句自然、简短的电话问候开场，例如“喂，我在。”，不要假设或回答用户尚未说出的内容。`,
  "这些标记约束只适用于各自所在的一轮；后续没有标记的普通文字消息保持正常回答方式。",
  "不要提及这个标记、JSON、语音通话的内部机制，也不要朗读 Markdown、文件路径、工具过程、内部状态或“正在处理”。如确实需要操作工具，先用一句简短的话说明，再继续完成事情。",
].join("\n");
const SELECTABLE_CLAUDE_ALLOWED_TOOLS = Object.freeze([
  ["read", "Read"],
  ["webFetch", "WebFetch"],
  ["webSearch", "WebSearch"],
]);

export class ConversationChatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationChatError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function longTermMemoryRecallSystemMessage(value) {
  const text = String(value ?? "");
  const start = text.indexOf(LONG_TERM_MEMORY_CONTEXT_OPEN);
  const end = text.indexOf(LONG_TERM_MEMORY_CONTEXT_CLOSE, start + LONG_TERM_MEMORY_CONTEXT_OPEN.length);
  if (start < 0 || end < 0) return "";
  const recalled = clean(text.slice(start + LONG_TERM_MEMORY_CONTEXT_OPEN.length, end));
  return recalled ? bounded(`记忆召回\n${recalled}`, MAX_EVENT_TEXT_LENGTH) : "";
}

function normalizeClaudeRuntimeFeatures(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...CLAUDE_RUNTIME_FEATURE_DEFAULTS,
    bash: source.bash !== false,
    edit: source.edit !== false,
    glob: source.glob !== false,
    grep: source.grep !== false,
    subagents: source.subagents === true,
    taskList: source.taskList === true,
    backgroundTasks: source.backgroundTasks === true,
    nativeCron: source.nativeCron === true,
    askUserQuestion: source.askUserQuestion === true,
    write: source.write !== false,
  };
}

export function claudeAllowedTools(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return SELECTABLE_CLAUDE_ALLOWED_TOOLS
    .filter(([key]) => source[key] !== false)
    .map(([, tool]) => tool);
}

function suzuCliAllowedTool(value) {
  const command = clean(value);
  if (!command || /[\r\n()]/u.test(command)) return "";
  return `Bash(${command} *)`;
}

function normalizeClaudeWorkspaceDirectories(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((item) => {
    const directory = clean(item);
    if (!directory || /[\r\n]/u.test(directory) || !path.isAbsolute(directory)) return [];
    const resolved = path.resolve(directory);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return [];
    seen.add(key);
    return [resolved];
  });
}

export function claudeAllowedToolsForWorkspace(value = {}, { suzuCliCommand = "" } = {}) {
  const cliPermission = suzuCliAllowedTool(suzuCliCommand);
  return [...claudeAllowedTools(value), ...(cliPermission ? [cliPermission] : [])];
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

function isToolPlanningAssistantMessage(value) {
  return clean(value?.type) === "assistant" && clean(value?.message?.stop_reason) === "tool_use";
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

function normalizeAgentVoiceCallRequest(value) {
  const source = plainObject(parsedObject(value));
  if (source.status !== "ok" || clean(source.capabilityId) !== "voice-call" || clean(source.action) !== "request") return null;
  const result = plainObject(source.result);
  if (clean(result.type) !== VOICE_CALL_REQUEST_RECEIPT) return null;
  return {
    reason: clean(result.reason).replace(/\s+/gu, " ").slice(0, 240),
  };
}

function voiceCallRequestsFromToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (clean(part?.type) !== "tool_result" || part?.is_error === true) return [];
    const source = part.content;
    if (Array.isArray(source)) {
      return source.flatMap((item) => {
        const request = normalizeAgentVoiceCallRequest(item?.text ?? item?.content ?? item);
        return request ? [request] : [];
      });
    }
    const request = normalizeAgentVoiceCallRequest(source);
    return request ? [request] : [];
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

function boundedDelay(value, fallback) {
  const delay = Number(value);
  return Number.isFinite(delay) && delay > 0 ? Math.trunc(delay) : fallback;
}

function streamSignature(args) {
  const source = Array.isArray(args) ? args : [];
  const sessionFlag = source.at(-2);
  const stable = ["--resume", "--session-id"].includes(sessionFlag)
    ? source.slice(0, -2)
    : source;
  return JSON.stringify(stable);
}

function inboundMediaFileName(value, fallback) {
  const name = path.basename(clean(value)).replace(/[\r\n]/gu, "").slice(0, 300);
  return name || fallback;
}

function normalizeInboundMedia(value, mediaSource = "wechat") {
  const items = Array.isArray(value) ? value : [];
  const sourceKey = clean(mediaSource).toLowerCase();
  if (!new Set(["wechat", "iphone", "sticker"]).has(sourceKey)) throw new ConversationChatError("会话附件来源无效。");
  if (items.length > MAX_INBOUND_MEDIA_ITEMS) {
    throw new ConversationChatError(`单条会话消息最多包含 ${MAX_INBOUND_MEDIA_ITEMS} 个附件。`);
  }
  if (sourceKey === "sticker" && items.length !== 1) throw new ConversationChatError("一条表情包消息只能包含一张图片。");
  return items.map((entry, index) => {
    const item = plainObject(entry);
    const kind = clean(item.kind).toLowerCase();
    if (!new Set(["image", "file"]).has(kind)) throw new ConversationChatError("会话附件类型无效。");
    if (sourceKey === "sticker" && kind !== "image") throw new ConversationChatError("表情包必须是图片。");
    const sourcePath = clean(item.path);
    if (!sourcePath || !path.isAbsolute(sourcePath)) throw new ConversationChatError("会话附件缓存路径无效。");
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data || []);
    if (!data.length || data.length > MAX_INBOUND_MEDIA_BYTES) {
      throw new ConversationChatError(`会话附件大小必须在 1 B 到 ${MAX_INBOUND_MEDIA_BYTES >> 20} MiB 之间。`);
    }
    return {
      kind,
      path: path.resolve(sourcePath),
      fileName: inboundMediaFileName(item.fileName, `${kind}-${index + 1}`),
      mimeType: clean(item.mimeType) || (kind === "image" ? "image/jpeg" : "application/octet-stream"),
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

function stickerMediaManifest(media) {
  return `${STICKER_MEDIA_MANIFEST_OPEN}${JSON.stringify({
    source: "suzu-sticker",
    type: "sticker",
    instruction: "这是用户以表情包形式发送的图片。请把它当作表情、情绪或反应理解，不要当成普通照片或文件附件。",
    items: media.map((item) => ({
      kind: item.kind,
      path: item.path,
      fileName: item.fileName,
      size: item.size,
    })),
  })}${STICKER_MEDIA_MANIFEST_CLOSE}`;
}

function voiceCallInputContent(text) {
  return `${VOICE_CALL_TURN_OPEN}\n${JSON.stringify({ source: "suzu-live-call", transcript: text })}\n${VOICE_CALL_TURN_CLOSE}`;
}

function voiceCallInitiator(value) {
  return clean(value).toLowerCase() === "agent" ? "agent" : "user";
}

function voiceCallOpeningContent(initiator = "user") {
  return `${VOICE_CALL_OPEN_OPEN}\n${JSON.stringify({ source: "suzu-live-call", event: "open", initiator: voiceCallInitiator(initiator) })}\n${VOICE_CALL_OPEN_CLOSE}`;
}

function voiceCallMemoryText(text) {
  return [
    "[系统事件：实时语音通话] 以下内容来自用户与联系人的实时语音通话，不是文字聊天。",
    `用户在本轮通话中说：${text}`,
  ].join("\n");
}

function voiceCallOpeningMemoryText(initiator = "user") {
  return voiceCallInitiator(initiator) === "agent"
    ? "[系统事件：实时语音通话已接通] 这不是用户说的话。联系人主动发起来电，用户接听后与联系人进入了一次实时语音通话；对方将以电话问候回应。"
    : "[系统事件：实时语音通话已接通] 这不是用户说的话。用户发起并接通了与联系人的一次实时语音通话；对方将以电话问候回应。";
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
  const manifest = mediaSource === "sticker"
    ? stickerMediaManifest(media)
    : wechatMediaManifest(media, mediaSource);
  const content = [text, manifest].filter(Boolean).join("\n\n");
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
  const list = clean(commands?.list);
  const remove = clean(commands?.remove);
  const chainPrompt = clean(commands?.proactiveChainPrompt) || "根据时间和前面聊的内容判断要不要主动联系对方，要发就正常发，不发就沉默，然后记得要设置下一次自动任务";
  const followUpPrompt = clean(commands?.proactiveFollowUpPrompt) || "临时回访：用户在 TIME 提到 EVENT。先检查当前会话里是否已经有结果；已经有结果就只输出 NO_REPLY；还没有结果就自然地关心或询问。不要提及自动任务、回访任务或系统机制。这是一次性回访，不要设置下一次自动任务。";
  if (!conversationAdd) return "";
  const sections = ["## Suzu 自动任务", "任务只会在 Suzu 软件运行期间执行；关闭期间不会执行或补跑。不要使用旧的 timer 或 cron 命令。"];
  if (conversationAdd) {
    sections.push(`### 主动关心\n\n当前会话已在“主动关心”能力中启用。一次性任务会自动绑定当前 Claude 会话和项目：\n\n${conversationAdd} --delay 45m --prompt "到时间后要处理的完整任务内容" --desc "简短说明"\n\n链式主动关心触发时使用这段提示词：\n\n${chainPrompt}\n\n临时回访使用这段提示词：\n\n${followUpPrompt}`);
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
export function claudeCliArguments({ sessionId, hasTranscript = false, appendSystemPrompt = "", claudeRuntimeFeatures, claudeToolPermissions, allowedTools = [], workspaceDirectories = [], permissionMode = DEFAULT_CLAUDE_PERMISSION_MODE } = {}) {
  const id = clean(sessionId);
  if (!id) throw new ConversationChatError("缺少 Claude 会话标识。");
  const extraPrompt = clean(appendSystemPrompt);
  const features = normalizeClaudeRuntimeFeatures(claudeRuntimeFeatures);
  const toolPermissions = claudeToolPermissions && typeof claudeToolPermissions === "object" && !Array.isArray(claudeToolPermissions)
    ? claudeToolPermissions
    : {};
  const selectedPermissionMode = normalizeClaudePermissionMode(permissionMode);
  const disallowedTools = [
    toolPermissions.read === false && "Read",
    !features.glob && "Glob",
    !features.grep && "Grep",
    !features.edit && "Edit",
    !features.write && "Write",
    !features.bash && "Bash",
    toolPermissions.webFetch === false && "WebFetch",
    toolPermissions.webSearch === false && "WebSearch",
    !features.subagents && "Agent",
    !features.taskList && "TodoWrite",
    !features.askUserQuestion && "AskUserQuestion",
  ].filter(Boolean);
  const permittedTools = [...new Set((Array.isArray(allowedTools) ? allowedTools : []).map(clean).filter((tool) => ["Read", "WebFetch", "WebSearch"].includes(tool) || /^Bash\([^\r\n()]+ \*\)$/u.test(tool)))];
  const sharedDirectories = normalizeClaudeWorkspaceDirectories(workspaceDirectories);
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--replay-user-messages",
    "--permission-mode", selectedPermissionMode,
    ...sharedDirectories.flatMap((directory) => ["--add-dir", directory]),
    ...(permittedTools.length ? ["--allowed-tools", permittedTools.join(",")] : []),
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
  claudeWorkspaceDirectories = [],
  suzuCliCommand = "",
  memoryRuntime = null,
  spawnImpl = spawn,
  onEvent = () => {},
  idleStreamTimeoutMs = TEXT_STREAM_IDLE_TIMEOUT_MS,
  idleStreamCloseGraceMs = TEXT_STREAM_CLOSE_GRACE_MS,
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
  const reusableTextStreams = new Map();
  const startingSessions = new Set();
  const startingTurns = new Map();
  const textStreamIdleTimeout = boundedDelay(idleStreamTimeoutMs, TEXT_STREAM_IDLE_TIMEOUT_MS);
  const textStreamCloseGrace = boundedDelay(idleStreamCloseGraceMs, TEXT_STREAM_CLOSE_GRACE_MS);
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

  const hasPendingTurn = ({ contactId, kind = "", scheduleSource = "" } = {}) => {
    const expectedContactId = clean(contactId);
    const expectedKind = clean(kind);
    const expectedScheduleSource = clean(scheduleSource);
    if (!expectedContactId) return false;
    const matches = (turn) => (
      clean(turn?.contactId) === expectedContactId
      && (!expectedKind || clean(turn?.kind) === expectedKind)
      && (!expectedScheduleSource || clean(turn?.scheduleSource) === expectedScheduleSource)
      && turn?.finished !== true
    );
    if ([...activeTurns.values()].some(matches)) return true;
    if ([...startingTurns.values()].some(matches)) return true;
    return [...pendingTurns.values()].some((queue) => queue.some(matches));
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

  const clearTextStreamTimer = (stream, name) => {
    const timer = stream?.[name];
    if (!timer) return;
    clearTimeout(timer);
    stream[name] = null;
  };

  const releaseTextStream = (stream) => {
    if (!stream) return;
    clearTextStreamTimer(stream, "idleTimer");
    clearTextStreamTimer(stream, "closeTimer");
    stream.closed = true;
    if (reusableTextStreams.get(stream.key) === stream) reusableTextStreams.delete(stream.key);
  };

  const closeTextStream = (stream, { force = false } = {}) => {
    if (!stream || stream.closed || stream.closing) return;
    clearTextStreamTimer(stream, "idleTimer");
    stream.closing = true;
    if (reusableTextStreams.get(stream.key) === stream) reusableTextStreams.delete(stream.key);
    if (force) {
      try { stream.child.kill?.("SIGTERM"); } catch { /* The process may already be stopping. */ }
      return;
    }
    try {
      if (!stream.child?.stdin || stream.child.stdin.destroyed || stream.child.stdin.writableEnded) throw new Error("Claude Code 输入流已经关闭。");
      stream.child.stdin.end();
    } catch {
      try { stream.child.kill?.("SIGTERM"); } catch { /* The process may already be stopping. */ }
      return;
    }
    stream.closeTimer = setTimeout(() => {
      stream.closeTimer = null;
      if (!stream.closed) {
        try { stream.child.kill?.("SIGTERM"); } catch { /* The process may already be stopping. */ }
      }
    }, textStreamCloseGrace);
    stream.closeTimer.unref?.();
  };

  const armTextStreamIdleClose = (stream) => {
    if (disposed || !stream || stream.closed || stream.closing || stream.turn || pendingTurns.get(stream.key)?.length) return;
    clearTextStreamTimer(stream, "idleTimer");
    stream.idleTimer = setTimeout(() => {
      stream.idleTimer = null;
      if (!stream.turn && !pendingTurns.get(stream.key)?.length) closeTextStream(stream);
    }, textStreamIdleTimeout);
    stream.idleTimer.unref?.();
  };

  const textStreamIsWritable = (stream) => Boolean(
    stream
      && !stream.closed
      && !stream.closing
      && !stream.turn
      && stream.child?.stdin
      && !stream.child.stdin.destroyed
      && !stream.child.stdin.writableEnded,
  );

  const removePermissionRequests = (turn) => {
    for (const requestId of turn.permissionIds) permissionRequests.delete(requestId);
    turn.permissionIds.clear();
  };

  const finishTurn = async (turn, { error = "", interrupted = false } = {}) => {
    if (turn.finished) return;
    turn.finished = true;
    activeTurns.delete(turn.key);
    removePermissionRequests(turn);
    if (turn.memoryTurn) {
      try {
        if (interrupted || error || !clean(turn.text)) {
          await memoryRuntime?.abortTurn?.(turn.memoryTurn);
        } else {
          await memoryRuntime?.completeTurn?.(turn.memoryTurn, {
            assistantText: turn.text,
            occurredAt: new Date().toISOString(),
          });
        }
      } catch {
        // A memory archive failure must not change the actual chat result.
      }
    }
    if (interrupted) {
      emit({
        type: "turn-stopped",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        deliverToWechat: turn.deliverToWechat,
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
        deliverToWechat: turn.deliverToWechat,
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
        deliverToWechat: turn.deliverToWechat,
        timestamp: new Date().toISOString(),
      });
    }
    void pumpSession(turn.sessionId, turn.projectRoot);
  };

  const createTurn = (request, memoryTurn, child, textStream = null) => ({
    agentCallRequestEmitted: false,
    agentMediaReceipts: new Set(),
    auxiliaryEvents: new Set(),
    child,
    completed: false,
    contactId: clean(request.contactId),
    deliverToWechat: request.deliverToWechat === true,
    finished: false,
    interrupted: false,
    kind: request.kind,
    lastAssistantText: "",
    key: request.key,
    memoryTurn,
    permissionIds: new Set(),
    projectRoot: request.projectRoot,
    requestId: request.requestId,
    resultError: "",
    scheduleSource: clean(request.scheduleSource),
    sessionId: request.sessionId,
    settling: false,
    stderr: "",
    text: "",
    textStream,
  });

  const settleTextStreamTurn = (stream, turn, outcome = {}) => {
    if (!stream || stream.turn !== turn || turn.settling) return;
    turn.settling = true;
    void finishTurn(turn, outcome).finally(() => {
      if (stream.turn !== turn) return;
      stream.turn = null;
      if (!stream.closed && !stream.closing) armTextStreamIdleClose(stream);
      void pumpSession(turn.sessionId, turn.projectRoot);
    });
  };

  const emitReply = (turn, type, done = false) => {
    if (!turn.text) return;
    emit({
      type,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      deliverToWechat: turn.deliverToWechat,
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
      deliverToWechat: turn.deliverToWechat,
      content: text,
      ...(clean(turn.contactId) ? { contactId: clean(turn.contactId) } : {}),
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
      deliverToWechat: turn.deliverToWechat,
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
        deliverToWechat: turn.deliverToWechat,
        media,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const emitAgentVoiceCallRequest = (turn, requests) => {
    if (turn.agentCallRequestEmitted || !clean(turn.contactId)) return;
    const request = requests[0];
    if (!request) return;
    turn.agentCallRequestEmitted = true;
    emit({
      type: "call-request",
      requestId: `${turn.requestId}:voice-call`,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      deliverToWechat: turn.deliverToWechat,
      contactId: turn.contactId,
      reason: clean(request.reason),
      timestamp: new Date().toISOString(),
    });
  };

  const handleWireMessage = (turn, raw, textStream = null) => {
    if (turn.interrupted || turn.settling || turn.finished) return;
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
        deliverToWechat: turn.deliverToWechat,
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
      emitAgentVoiceCallRequest(turn, voiceCallRequestsFromToolResults(raw?.message?.content));
      for (const item of auxiliaryParts(raw?.message?.content)) emitAuxiliary(turn, item.type, item.content);
      const next = messageText(raw?.message?.content);
      if (next) {
        if (isToolPlanningAssistantMessage(raw)) {
          emitAuxiliary(turn, "thinking", next);
          return;
        }
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
      emitAgentVoiceCallRequest(turn, voiceCallRequestsFromToolResults(raw?.message?.content));
      for (const item of auxiliaryParts(raw?.message?.content)) emitAuxiliary(turn, item.type, item.content);
      return;
    }
    if (type === "attachment" || type === "hook_additional_context") {
      const attachment = raw?.attachment && typeof raw.attachment === "object" ? raw.attachment : raw;
      const content = Array.isArray(attachment.content) ? attachment.content.join("\n") : attachment.content;
      const memoryRecall = longTermMemoryRecallSystemMessage(content);
      if (memoryRecall) {
        emitAuxiliary(turn, "system", memoryRecall);
        return;
      }
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
        toolName: clean(request.tool_name) || "Claude Code 工具",
      };
      turn.permissionIds.add(requestId);
      permissionRequests.set(requestId, permission);
      emit({
        type: "permission",
        requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        deliverToWechat: turn.deliverToWechat,
        toolName: permission.toolName,
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
    if (textStream) {
      settleTextStreamTurn(textStream, turn, { error: turn.resultError });
      if (turn.resultError) closeTextStream(textStream);
      return;
    }
    try { turn.child.stdin?.end(); } catch { /* Closing after a final result is best effort. */ }
  };

  const finishTextStreamProcess = (stream, { code = null, signal = null, error = "" } = {}) => {
    if (!stream || stream.closed) return;
    const turn = stream.turn;
    try { stream.output?.close(); } catch { /* Closing a completed reader is best effort. */ }
    releaseTextStream(stream);
    if (!turn) {
      void pumpSession(stream.sessionId, stream.projectRoot);
      return;
    }
    if (turn.settling || turn.finished) return;
    if (turn.interrupted) {
      settleTextStreamTurn(stream, turn, { interrupted: true });
      return;
    }
    if (turn.completed || code === 0) {
      if (!turn.completed) {
        if (turn.text && clean(turn.text) !== clean(turn.lastAssistantText)) emitAgentReply(turn, turn.text);
        emitCompletedReply(turn);
      }
      settleTextStreamTurn(stream, turn, { error: turn.resultError });
      return;
    }
    const detail = clean(error || turn.stderr).replace(/\s+/gu, " ");
    const reason = signal
      ? `Claude Code 已停止（${signal}）。`
      : `Claude Code 未能完成这次回复（退出代码 ${code ?? "未知"}）。`;
    settleTextStreamTurn(stream, turn, { error: detail ? `${reason} ${detail}` : reason });
  };

  const createTextStream = (child, request, signature) => {
    const stream = {
      child,
      closeTimer: null,
      closed: false,
      closing: false,
      idleTimer: null,
      key: request.key,
      output: null,
      projectRoot: request.projectRoot,
      sessionId: request.sessionId,
      signature,
      turn: null,
    };
    reusableTextStreams.set(stream.key, stream);
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    stream.output = output;
    output.on("line", (line) => {
      const turn = stream.turn;
      if (!turn) return;
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      handleWireMessage(turn, raw, stream);
    });
    child.stderr?.on?.("data", (chunk) => {
      const turn = stream.turn;
      if (turn) turn.stderr = bounded(`${turn.stderr}${String(chunk)}`, 6_000);
    });
    child.on?.("error", (error) => {
      finishTextStreamProcess(stream, {
        error: `无法运行本机 Claude Code：${processErrorMessage(error, "进程启动失败。")}`,
      });
      try { child.kill?.("SIGTERM"); } catch { /* The process may already be stopping. */ }
    });
    child.on?.("close", (code, signal) => finishTextStreamProcess(stream, { code, signal }));
    return stream;
  };

  const startTextStreamTurn = (stream, request, memoryTurn) => {
    clearTextStreamTimer(stream, "idleTimer");
    const turn = createTurn(request, memoryTurn, stream.child, stream);
    stream.turn = turn;
    activeTurns.set(request.key, turn);
    emit({
      type: "turn-start",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      timestamp: new Date().toISOString(),
    });
    try {
      writeJson(stream.child, { type: "user", message: { role: "user", content: request.content } });
      knownTranscripts.add(request.key);
    } catch (error) {
      settleTextStreamTurn(stream, turn, { error: processErrorMessage(error, "无法向 Claude Code 发送消息。") });
      closeTextStream(stream, { force: true });
    }
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
      ? await Promise.resolve(agentScheduleCommand({ sessionId: request.sessionId, projectRoot: request.projectRoot }))
      : null;
    const currentSettings = settingsService.load() || {};
    const claudeRuntimeFeatures = currentSettings.claudeRuntimeFeatures;
    let memoryTurn = null;
    if (["message", "call", "call-open", "iphone-feedback"].includes(request.kind)
      && clean(request.memoryText)
      && typeof memoryRuntime?.prepareTurn === "function") {
      try {
        memoryTurn = await memoryRuntime.prepareTurn({
          occurredAt: request.memoryOccurredAt,
          projectRoot: request.projectRoot,
          sessionId: request.sessionId,
          turnId: request.requestId,
          userText: request.memoryText,
        });
      } catch {
        memoryTurn = null;
      }
    }
    if (disposed) {
      try { await memoryRuntime?.abortTurn?.(memoryTurn); } catch { /* A stopped chat needs no memory cursor. */ }
      return;
    }
    const supportsVoiceCallTurns = ["message", "call", "call-open"].includes(request.kind);
    const args = claudeCliArguments({
      sessionId: request.sessionId,
      hasTranscript: request.hasTranscript || knownTranscripts.has(request.key),
      claudeRuntimeFeatures,
      claudeToolPermissions: currentSettings.claudeToolPermissions,
      allowedTools: claudeAllowedToolsForWorkspace(currentSettings.claudeToolPermissions, { suzuCliCommand }),
      permissionMode: request.approvalMode,
      workspaceDirectories: claudeWorkspaceDirectories,
      appendSystemPrompt: [
        wechatAttachmentSystemPrompt(attachmentCommand),
        scheduleSystemPrompt(scheduleCommands),
        supportsVoiceCallTurns ? VOICE_CALL_SYSTEM_PROMPT : "",
      ].filter(Boolean).join("\n\n"),
    });
    // Long-term recall is injected by UserPromptSubmit alongside this user
    // record. It no longer changes --append-system-prompt, so a recalled turn
    // can keep using the same persistent Claude stream as every other turn.
    const canReuseConversationStream = supportsVoiceCallTurns;
    const signature = canReuseConversationStream ? streamSignature(args) : "";
    const existingTextStream = reusableTextStreams.get(request.key);
    if (canReuseConversationStream
      && textStreamIsWritable(existingTextStream)
      && existingTextStream.signature === signature) {
      startTextStreamTurn(existingTextStream, request, memoryTurn);
      return;
    }
    // A turn outside normal text/call or changed runtime options needs a fresh
    // Claude process. Retire only an idle text stream; an active stream is
    // protected by the session queue.
    if (existingTextStream && !existingTextStream.turn) closeTextStream(existingTextStream);
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: request.projectRoot,
        env: claudeCliEnvironment({
          claudeRuntimeFeatures,
        }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      try { await memoryRuntime?.abortTurn?.(memoryTurn); } catch { /* The spawn error remains primary. */ }
      throw new ConversationChatError(`无法启动本机 Claude Code：${processErrorMessage(error, "启动失败。")}`);
    }
    if (!child?.stdin || !child?.stdout) {
      try { child?.kill?.(); } catch { /* The process may not have started. */ }
      try { await memoryRuntime?.abortTurn?.(memoryTurn); } catch { /* The local pipe error remains primary. */ }
      throw new ConversationChatError("无法建立 Claude Code 的本地输入输出通道。");
    }

    if (canReuseConversationStream) {
      const textStream = createTextStream(child, request, signature);
      startTextStreamTurn(textStream, request, memoryTurn);
      return;
    }

    const turn = createTurn(request, memoryTurn, child);
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
      void finishTurn(turn, turn.interrupted
        ? { interrupted: true }
        : { error: `无法运行本机 Claude Code：${processErrorMessage(error, "进程启动失败。")}` });
    });
    child.on?.("close", (code, signal) => {
      output.close();
      if (turn.finished) return;
      if (turn.interrupted) {
        void finishTurn(turn, { interrupted: true });
        return;
      }
      if (turn.completed || code === 0) {
        if (!turn.completed) {
          if (turn.kind !== "schedule" && turn.text && clean(turn.text) !== clean(turn.lastAssistantText)) emitAgentReply(turn, turn.text);
          emitCompletedReply(turn);
        }
        void finishTurn(turn, { error: turn.resultError });
        return;
      }
      const detail = clean(turn.stderr).replace(/\s+/gu, " ");
      const reason = signal
        ? `Claude Code 已停止（${signal}）。`
        : `Claude Code 未能完成这次回复（退出代码 ${code ?? "未知"}）。`;
      void finishTurn(turn, { error: detail ? `${reason} ${detail}` : reason });
    });
    try {
      writeJson(child, { type: "user", message: { role: "user", content: request.content } });
      knownTranscripts.add(request.key);
    } catch (error) {
      void finishTurn(turn, { error: processErrorMessage(error, "无法向 Claude Code 发送消息。") });
      try { child.kill?.(); } catch { /* The error is already emitted to the conversation. */ }
    }
  };

  const pumpSession = async (sessionId, projectRoot, { propagateStartError = false } = {}) => {
    const key = turnKey(sessionId, projectRoot);
    if (disposed || activeTurns.has(key) || reusableTextStreams.get(key)?.turn || startingSessions.has(key)) return;
    const queue = pendingTurns.get(key);
    if (!queue?.length) return;
    const request = queue.shift();
    if (!queue.length) pendingTurns.delete(key);
    emitQueue(sessionId, request.projectRoot);
    startingSessions.add(key);
    startingTurns.set(key, request);
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
      if (startingTurns.get(key) === request) startingTurns.delete(key);
      if (!disposed && !activeTurns.has(key)) void pumpSession(sessionId, projectRoot);
    }
  };

  const permissionModeForSession = async ({ sessionId, projectRoot } = {}) => {
    if (typeof reader?.approvalModeForSession !== "function") return DEFAULT_CLAUDE_PERMISSION_MODE;
    try {
      return normalizeClaudePermissionMode(await reader.approvalModeForSession({ sessionId, projectRoot }));
    } catch {
      return DEFAULT_CLAUDE_PERMISSION_MODE;
    }
  };

  const resolveSession = async ({ sessionId, projectRoot, hasTranscript } = {}) => {
    const id = clean(sessionId);
    const root = clean(projectRoot);
    if (!id && !root) {
      const session = await reader.ensureActiveSession();
      return { ...session, approvalMode: normalizeClaudePermissionMode(session?.approvalMode) };
    }
    if (!id || !root) throw new ConversationChatError("指定 Claude 会话时必须同时提供会话标识和工作目录。");
    return {
      id,
      projectRoot: root,
      hasTranscript: hasTranscript === true,
      approvalMode: await permissionModeForSession({ sessionId: id, projectRoot: root }),
    };
  };

  const enqueue = async ({ content, contactId = "", kind = "message", callDirection = "", media: suppliedMedia = [], mediaSource = "wechat", memoryText: suppliedMemoryText = "", requestId: suppliedRequestId = "", scheduleSource = "", deliverToWechat = false, session: requestedSession = null } = {}) => {
    if (disposed) throw new ConversationChatError("聊天服务已经停止。");
    const normalizedMediaSource = clean(mediaSource).toLowerCase() || "wechat";
    const media = normalizeInboundMedia(suppliedMedia, normalizedMediaSource);
    const voiceCallOpening = kind === "call-open";
    const text = validateContent(content, { allowEmpty: media.length > 0 || voiceCallOpening });
    const session = await resolveSession(requestedSession || {});
    if (!session?.id || !session.projectRoot) throw new ConversationChatError("请先选择 Claude 工作目录。");
    let resolvedContactId = clean(contactId);
    if (!resolvedContactId && typeof reader.contactIdForSession === "function") {
      try {
        resolvedContactId = clean(await reader.contactIdForSession({ sessionId: session.id, projectRoot: session.projectRoot }));
      } catch {
        // A missing optional contact lookup must not prevent a normal chat turn.
      }
    }
    const callInitiator = voiceCallInitiator(callDirection);
    let projectStat;
    try { projectStat = await fsOps.stat(session.projectRoot); }
    catch { throw new ConversationChatError("当前 Claude 工作目录不存在或无法读取。"); }
    if (!isDirectory(projectStat)) throw new ConversationChatError("当前 Claude 工作目录不是文件夹。");

    const request = {
      content: claudeInputContent(
        kind === "call"
          ? voiceCallInputContent(text)
          : voiceCallOpening
            ? voiceCallOpeningContent(callInitiator)
            : text,
        media,
        normalizedMediaSource,
      ),
      contactId: resolvedContactId,
      deliverToWechat: deliverToWechat === true,
      hasTranscript: Boolean(session.hasTranscript) || knownTranscripts.has(turnKey(session.id, session.projectRoot)),
      kind,
      approvalMode: session.approvalMode,
      key: turnKey(session.id, session.projectRoot),
      memoryOccurredAt: new Date().toISOString(),
      memoryText: kind === "call"
        ? voiceCallMemoryText(text)
        : voiceCallOpening
          ? voiceCallOpeningMemoryText(callInitiator)
          : clean(suppliedMemoryText) || text,
      projectRoot: session.projectRoot,
      requestId: clean(suppliedRequestId) || `suzu-${randomUUID()}`,
      scheduleSource: clean(scheduleSource),
      sessionId: session.id,
    };
    const queue = queueFor(session.id, session.projectRoot);
    if (queue.length >= MAX_QUEUED_TURNS) {
      throw new ConversationChatError(`当前会话最多只能排队 ${MAX_QUEUED_TURNS} 条消息，请等待部分任务完成后再发送。`);
    }
    const queued = activeTurns.has(request.key)
      || reusableTextStreams.get(request.key)?.turn
      || startingSessions.has(request.key)
      || queue.length > 0;
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

  const send = ({ content, media = [], mediaSource = "wechat", memoryText = "" } = {}) => enqueue({ content, media, mediaSource, memoryText, deliverToWechat: false });
  const sendToSession = ({ content, contactId = "", sessionId, projectRoot, hasTranscript = false, kind = "message", callDirection = "", media = [], mediaSource = "wechat", memoryText = "", requestId = "", scheduleSource = "", deliverToWechat = true } = {}) => (
    enqueue({ content, contactId, kind, callDirection, media, mediaSource, memoryText, requestId, scheduleSource, deliverToWechat, session: { sessionId, projectRoot, hasTranscript } })
  );

  const stop = ({ sessionId, projectRoot, requestId } = {}) => {
    const id = clean(sessionId);
    if (!id) throw new ConversationChatError("缺少要停止的 Claude 会话标识。");
    const root = clean(projectRoot);
    const requestedRequestId = clean(requestId);
    const matches = root
      ? [activeTurns.get(turnKey(id, root))].filter(Boolean)
      : [...activeTurns.values()].filter((item) => item.sessionId === id);
    if (matches.length > 1) throw new ConversationChatError("同名 Claude 会话正在多个工作目录中运行，请从对应会话里停止。 ");
    const turn = requestedRequestId ? matches.find((item) => item.requestId === requestedRequestId) : matches[0];
    if (requestedRequestId && !turn) {
      const queues = root
        ? [pendingTurns.get(turnKey(id, root))].filter(Boolean)
        : [...pendingTurns.entries()]
          .filter(([, queue]) => queue.some((item) => item.sessionId === id))
          .map(([, queue]) => queue);
      for (const queue of queues) {
        const index = queue.findIndex((item) => item.requestId === requestedRequestId);
        if (index < 0) continue;
        const [queued] = queue.splice(index, 1);
        if (!queue.length) pendingTurns.delete(queued.key);
        emitQueue(queued.sessionId, queued.projectRoot);
        emit({
          type: "turn-stopped",
          requestId: queued.requestId,
          sessionId: queued.sessionId,
          projectRoot: queued.projectRoot,
          kind: queued.kind,
          message: "已停止当前 Claude Code 任务。",
          timestamp: new Date().toISOString(),
        });
        return { accepted: true, stopped: true, sessionId: id, message: "已从队列中移除这次回复。" };
      }
    }
    if (!turn) {
      return {
        accepted: true,
        stopped: false,
        sessionId: id,
        message: requestedRequestId ? "这条通话回复已经结束或不在当前会话中。" : "当前会话没有正在执行的 Claude Code 任务。",
      };
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
    if (!["allow", "deny"].includes(behavior)) throw new ConversationChatError("权限选择无效。");
    const allow = behavior === "allow";
    const toolName = clean(permission?.toolName) || "Claude Code 工具";
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
    const result = { accepted: true, requestId: id, behavior: allow ? "allow" : "deny", toolName };
    emit({
      type: "permission-resolved",
      requestId: id,
      sessionId: permission.turn.sessionId,
      projectRoot: permission.turn.projectRoot,
      behavior: result.behavior,
      toolName,
      timestamp: new Date().toISOString(),
    });
    return result;
  };

  const respondPermissionForSession = ({ sessionId, projectRoot, behavior } = {}) => {
    const key = turnKey(sessionId, projectRoot);
    const pending = [...permissionRequests.values()].filter((permission) => (
      permission.turn.key === key && !permission.turn.finished
    ));
    if (!pending.length) return { accepted: false, reason: "no-pending-permission" };
    if (pending.length > 1) return { accepted: false, reason: "multiple-pending-permissions" };
    return respondPermission({ requestId: pending[0].requestId, behavior });
  };

  const dispose = () => {
    disposed = true;
    pendingTurns.clear();
    startingSessions.clear();
    startingTurns.clear();
    for (const turn of activeTurns.values()) {
      turn.finished = true;
      removePermissionRequests(turn);
      try {
        const aborting = memoryRuntime?.abortTurn?.(turn.memoryTurn);
        void Promise.resolve(aborting).catch(() => undefined);
      } catch {
        // The local child process still needs to be stopped even if memory cleanup throws.
      }
      try { turn.child.kill?.(); } catch { /* Only processes created by this service are touched. */ }
    }
    for (const stream of [...reusableTextStreams.values()]) closeTextStream(stream, { force: true });
    activeTurns.clear();
    permissionRequests.clear();
  };

  return {
    dispose,
    hasPendingTurn,
    respondPermission,
    respondPermissionForSession,
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
