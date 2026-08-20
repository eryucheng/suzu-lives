import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

import { Session } from "@suzu-lives/suzu-agent-runtime/core/session";

import { resolveAgentSessionStoragePaths } from "./agent-session-storage.mjs";
import { resolveSuzuAgentRuntimePaths } from "./suzu-agent-runtime.mjs";

const CONTACT_ID_PATTERN = /^contact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AGENT_ID_PATTERN = /^agent-[a-z0-9][a-z0-9_-]{0,121}$/iu;
const EXTERNAL_CAPABILITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const MAX_LEGACY_TRANSCRIPT_BYTES = 100 * 1024 * 1024;
const MAX_LEGACY_TRANSCRIPT_LINES = 250_000;
const LEGACY_SETTINGS_KEYS = new Set([
  "claudeProjectDefaults",
  "claudeRuntimeFeatures",
  "claudeToolPermissions",
]);
const LEGACY_HOOK_ROLES = new Set([
  "time-awareness",
  "memory-recall",
  "user-prompt",
  "assistant-stop",
]);
// These are the direct, project-local Claude Skills that public 0.1.x
// generated itself.  External Skills use a separate ownership manifest and
// are handled by the external-capability adoption path below.
//
// traveling-merchant deliberately stays out of this list: the final Agent Core
// registry intentionally no longer exposes that feature, so there is no
// native equivalent that justifies removing the old user-visible entry.
const LEGACY_DIRECT_CLAUDE_SKILL_IDS = new Set([
  "image-generation",
  "phone-camera",
  "time-awareness",
  "image-vision",
  "video-understanding",
  "voice-message",
  "voice-call",
  "visual-reference-manager",
  "site-automation",
  "iphone-bridge",
  "proactive-contact",
]);
const LEGACY_UNMAPPED_CLAUDE_SKILL_IDS = new Set(["traveling-merchant"]);
const ZSTD_CHECKSUM_OPTIONS = {
  params: {
    [zlibConstants.ZSTD_c_checksumFlag]: 1,
  },
};
const ZSTD_MAGIC = 0xFD2FB528;
const MAX_NATIVE_ARTIFACT_FRAMES = 4_096;

export class LegacyMigrationError extends Error {
  constructor(message, { cause, code = "LEGACY_MIGRATION_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LegacyMigrationError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validContactId(value) {
  const id = clean(value).toLowerCase();
  return CONTACT_ID_PATTERN.test(id) ? id : "";
}

function validSessionId(value) {
  const id = clean(value);
  return SESSION_ID_PATTERN.test(id) ? id : "";
}

function validAgentId(value) {
  const id = clean(value).toLowerCase();
  return AGENT_ID_PATTERN.test(id) ? id : "";
}

function boundedText(value, maximum = 200_000) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum)}\n[旧版内容已截断]` : text;
}

function timestamp(value, fallback) {
  const parsed = Date.parse(clean(value));
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function serializable(value, fallback = "[旧版内容无法序列化]") {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? fallback : boundedText(text, 40_000);
  } catch {
    return fallback;
  }
}

async function lstatIfPresent(fsOps, target) {
  try {
    return await fsOps.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ordinaryDirectoryIfPresent(fsOps, target, label) {
  const requested = clean(target);
  if (!requested || !path.isAbsolute(requested)) return "";
  const resolved = path.resolve(requested);
  const stat = await lstatIfPresent(fsOps, resolved);
  if (!stat) return "";
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LegacyMigrationError(`${label}不是可安全读取的普通文件夹。`, { code: "UNSAFE_DIRECTORY" });
  }
  const real = await fsOps.realpath(resolved);
  if (!samePath(real, resolved)) {
    throw new LegacyMigrationError(`${label}解析后的位置发生变化，已拒绝处理。`, { code: "UNSAFE_DIRECTORY" });
  }
  return real;
}

async function ordinaryFileIfPresent(fsOps, target, label, { maximumBytes = Number.POSITIVE_INFINITY } = {}) {
  const resolved = path.resolve(target);
  const stat = await lstatIfPresent(fsOps, resolved);
  if (!stat) return { exists: false, bytes: Buffer.alloc(0), path: resolved };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacyMigrationError(`${label}不是可安全读取的普通文件。`, { code: "UNSAFE_FILE" });
  }
  if (stat.size > maximumBytes) {
    throw new LegacyMigrationError(`${label}超过可安全迁移的大小。`, { code: "FILE_TOO_LARGE" });
  }
  const raw = await fsOps.readFile(resolved);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const after = await lstatIfPresent(fsOps, resolved);
  if (!after || after.isSymbolicLink() || !after.isFile() || after.size !== bytes.byteLength) {
    throw new LegacyMigrationError(`${label}在读取时发生了不安全变更。`, { code: "UNSAFE_FILE" });
  }
  return { exists: true, bytes, path: resolved };
}

async function readJsonFileIfPresent(fsOps, target, label, options = {}) {
  const source = await ordinaryFileIfPresent(fsOps, target, label, options);
  if (!source.exists) return { ...source, value: null };
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new LegacyMigrationError(`${label}不是有效 JSON。`, { cause: error, code: "INVALID_JSON" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyMigrationError(`${label}的根节点必须是对象。`, { code: "INVALID_JSON" });
  }
  return { ...source, value };
}

async function writeBytesAtomically(fsOps, target, bytes, label) {
  const destination = path.resolve(target);
  const parent = path.dirname(destination);
  const parentStat = await lstatIfPresent(fsOps, parent);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new LegacyMigrationError(`${label}的父目录不可安全写入。`, { code: "UNSAFE_DESTINATION" });
  }
  const existing = await lstatIfPresent(fsOps, destination);
  if (existing) throw new LegacyMigrationError(`${label}已经存在，已拒绝覆盖。`, { code: "DESTINATION_EXISTS" });
  const temporary = `${destination}.suzu-legacy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, bytes, { flag: "wx" });
  try {
    const beforeRename = await lstatIfPresent(fsOps, destination);
    if (beforeRename) throw new LegacyMigrationError(`${label}在写入期间出现，已拒绝覆盖。`, { code: "DESTINATION_EXISTS" });
    await fsOps.rename(temporary, destination);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
  const written = await ordinaryFileIfPresent(fsOps, destination, label);
  if (!written.bytes.equals(Buffer.from(bytes))) {
    throw new LegacyMigrationError(`${label}写入校验失败。`, { code: "WRITE_VERIFICATION_FAILED" });
  }
  return destination;
}

async function replaceBytesAtomically(fsOps, target, expectedHash, bytes, label) {
  const destination = path.resolve(target);
  const expectedBytes = Buffer.from(bytes);
  const current = await ordinaryFileIfPresent(fsOps, destination, label, {
    maximumBytes: MAX_LEGACY_TRANSCRIPT_BYTES,
  });
  if (!current.exists) {
    throw new LegacyMigrationError(`${label}在替换前不存在，已拒绝写入。`, { code: "SOURCE_MISSING" });
  }
  if (sha256(current.bytes) !== expectedHash) {
    throw new LegacyMigrationError(`${label}在替换前已被修改，已保留原文件。`, { code: "SOURCE_CHANGED" });
  }
  const parent = path.dirname(destination);
  const parentStat = await lstatIfPresent(fsOps, parent);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new LegacyMigrationError(`${label}的父目录不可安全写入。`, { code: "UNSAFE_DESTINATION" });
  }
  const temporary = `${destination}.suzu-legacy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, expectedBytes, { flag: "wx" });
  try {
    const beforeRename = await ordinaryFileIfPresent(fsOps, destination, label, {
      maximumBytes: MAX_LEGACY_TRANSCRIPT_BYTES,
    });
    if (!beforeRename.exists || sha256(beforeRename.bytes) !== expectedHash) {
      throw new LegacyMigrationError(`${label}在替换期间被修改，已保留原文件。`, { code: "SOURCE_CHANGED" });
    }
    await fsOps.rename(temporary, destination);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
  const written = await ordinaryFileIfPresent(fsOps, destination, label, {
    maximumBytes: MAX_LEGACY_TRANSCRIPT_BYTES,
  });
  if (!written.bytes.equals(expectedBytes)) {
    throw new LegacyMigrationError(`${label}替换后校验失败。`, { code: "WRITE_VERIFICATION_FAILED" });
  }
  return destination;
}

async function ensureOrdinaryDirectory(fsOps, target, label) {
  const resolved = path.resolve(target);
  const present = await lstatIfPresent(fsOps, resolved);
  if (!present) await fsOps.mkdir(resolved, { recursive: true });
  const stat = await lstatIfPresent(fsOps, resolved);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LegacyMigrationError(`${label}不是可安全写入的普通文件夹。`, { code: "UNSAFE_DIRECTORY" });
  }
  return resolved;
}

async function removeRegularFileAfterHash(fsOps, target, expectedHash, label) {
  const source = await ordinaryFileIfPresent(fsOps, target, label, { maximumBytes: MAX_LEGACY_TRANSCRIPT_BYTES });
  if (!source.exists) return false;
  if (sha256(source.bytes) !== expectedHash) {
    throw new LegacyMigrationError(`${label}在迁移期间被修改，已保留原文件。`, { code: "SOURCE_CHANGED" });
  }
  await fsOps.unlink(source.path);
  return true;
}

async function removeDirectoryIfEmpty(fsOps, target) {
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const entries = await fsOps.readdir(target);
  if (entries.length) return false;
  await fsOps.rmdir(target);
  return true;
}

function legacyClaudeProjectKeys(projectRoot) {
  const absolute = path.resolve(projectRoot);
  const forward = absolute.replaceAll("\\", "/");
  const claudeKey = Array.from(forward, (character) => {
    const codePoint = character.codePointAt(0) || 0;
    return ["/", ":", "_", " ", "~", ".", "@"].includes(character) || codePoint > 127 ? "-" : character;
  }).join("");
  return [...new Set([
    claudeKey,
    absolute.replaceAll(path.sep, "-"),
    absolute.replace(/[\\/:]/gu, "-"),
    absolute.replace(/[\\/:_]/gu, "-"),
    forward.replaceAll("/", "-"),
  ].map(clean).filter(Boolean))];
}

export function legacyClaudeProjectDirectoryCandidates({ projectRoot, homeDirectory = os.homedir() } = {}) {
  const root = clean(projectRoot);
  if (!root || !path.isAbsolute(root)) return [];
  const home = clean(homeDirectory) || os.homedir();
  const projectsRoot = path.join(path.resolve(home), ".claude", "projects");
  return legacyClaudeProjectKeys(path.resolve(root)).map((key) => path.join(projectsRoot, key));
}

function legacyContentToText(content) {
  if (typeof content === "string") return boundedText(content).trim();
  if (!Array.isArray(content)) return "";
  const pieces = [];
  for (const rawPart of content) {
    const part = plainObject(rawPart);
    const type = clean(part.type);
    if (type === "text" && typeof part.text === "string") {
      if (part.text.trim()) pieces.push(boundedText(part.text));
      continue;
    }
    if (type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      pieces.push(`【旧版思考】\n${boundedText(part.thinking)}`);
      continue;
    }
    if (type === "tool_use") {
      const name = clean(part.name) || "工具";
      pieces.push(`【旧版工具调用：${name}】\n${serializable(part.input ?? part)}`);
      continue;
    }
    if (type === "tool_result") {
      const result = legacyContentToText(part.content) || serializable(part.content ?? part);
      pieces.push(`【旧版工具结果${part.is_error === true || part.isError === true ? "（错误）" : ""}】\n${result}`);
      continue;
    }
    if (type === "image") {
      pieces.push("【旧版图片附件】图片二进制不在 Claude JSONL 内，已保留文字会话。 ");
      continue;
    }
    if (type) pieces.push(`【旧版内容：${type}】\n${serializable(part)}`);
  }
  return boundedText(pieces.join("\n\n")).trim();
}

function isLegacySyntheticRecord(record) {
  const source = plainObject(record);
  const message = plainObject(source.message);
  if (source.type === "user" && (source.isMeta === true || message.isMeta === true)) return true;
  if (source.type !== "assistant") return false;
  const model = clean(message.model || source.model);
  const content = legacyContentToText(message.content ?? source.content);
  return model === "<synthetic>" && content === "NO_REPLY";
}

export function legacyClaudeTranscriptEvents({ bytes, fallbackTime = Date.now(), sessionId } = {}) {
  const id = validSessionId(sessionId);
  if (!id) throw new LegacyMigrationError("旧会话标识无效。", { code: "INVALID_SESSION_ID" });
  const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes ?? "");
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines.length > MAX_LEGACY_TRANSCRIPT_LINES) {
    throw new LegacyMigrationError("旧 JSONL 记录数超过可安全迁移上限。", { code: "TOO_MANY_TRANSCRIPT_LINES" });
  }
  const messages = [];
  let malformedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (isLegacySyntheticRecord(record)) continue;
    const message = plainObject(record.message);
    const role = record.type === "user" ? "user" : record.type === "assistant" ? "assistant" : "";
    if (!role) continue;
    const content = legacyContentToText(message.content ?? record.content);
    if (!content || (role === "assistant" && content === "NO_REPLY")) continue;
    const time = timestamp(record.timestamp || message.timestamp, fallbackTime + index);
    messages.push({
      role,
      text: content,
      time,
      line: index + 1,
    });
  }
  if (!messages.length) {
    throw new LegacyMigrationError("旧 JSONL 中没有可迁移的人类对话消息。", { code: "NO_CONVERSATION_MESSAGES" });
  }
  const events = messages.map((message, index) => {
    const messageId = `legacy-${message.role}-${sha256(`${id}\u0000${message.line}\u0000${message.text}`).slice(0, 32)}`;
    const text = message.text;
    if (message.role === "user") {
      return {
        type: "user/message",
        seq: index,
        time: message.time,
        data: {
          id: messageId,
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      };
    }
    return {
      type: "assistant/message",
      seq: index,
      time: message.time,
      data: {
        message: {
          id: messageId,
          role: "assistant",
          content: [{ type: "text", text }],
          source: { kind: "model", provider: "legacy-claude", model: "legacy-import" },
        },
      },
      surfaceOp: "append",
    };
  });
  return {
    events,
    malformedLines,
    messageCount: messages.length,
    createdAt: Math.min(...messages.map((message) => message.time)),
  };
}

function nextZstdFrameEnd(source) {
  const buffer = Buffer.from(source);
  let offset = 0;
  if (buffer.length < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new LegacyMigrationError("写入的 Agent Core 会话包含无效的 Zstandard 帧。", { code: "NATIVE_SESSION_INVALID" });
  }
  offset += 4;
  if (offset === buffer.length) {
    throw new LegacyMigrationError("写入的 Agent Core 会话缺少 Zstandard 帧头。", { code: "NATIVE_SESSION_INVALID" });
  }
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 24) !== 0) {
    throw new LegacyMigrationError("写入的 Agent Core 会话使用了不受支持的 Zstandard 帧头。", { code: "NATIVE_SESSION_INVALID" });
  }
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) {
    throw new LegacyMigrationError("写入的 Agent Core 会话包含不完整的 Zstandard 帧头。", { code: "NATIVE_SESSION_INVALID" });
  }
  offset += remainingHeaderBytes;
  for (;;) {
    if (buffer.length - offset < 3) {
      throw new LegacyMigrationError("写入的 Agent Core 会话包含不完整的 Zstandard 数据块。", { code: "NATIVE_SESSION_INVALID" });
    }
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) {
      throw new LegacyMigrationError("写入的 Agent Core 会话包含保留的 Zstandard 数据块类型。", { code: "NATIVE_SESSION_INVALID" });
    }
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) {
      throw new LegacyMigrationError("写入的 Agent Core 会话包含不完整的 Zstandard 数据块。", { code: "NATIVE_SESSION_INVALID" });
    }
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (buffer.length - offset < 4) {
      throw new LegacyMigrationError("写入的 Agent Core 会话包含不完整的 Zstandard 校验值。", { code: "NATIVE_SESSION_INVALID" });
    }
    offset += 4;
  }
  return offset;
}

function decompressZstdFrameSequence(bytes) {
  const source = Buffer.from(bytes);
  const output = [];
  let offset = 0;
  for (let index = 0; offset < source.byteLength; index += 1) {
    if (index >= MAX_NATIVE_ARTIFACT_FRAMES) {
      throw new LegacyMigrationError("写入的 Agent Core 会话包含过多 Zstandard 帧。", { code: "NATIVE_SESSION_INVALID" });
    }
    const frameLength = nextZstdFrameEnd(source.subarray(offset));
    try {
      output.push(zstdDecompressSync(source.subarray(offset, offset + frameLength)));
    } catch (error) {
      throw new LegacyMigrationError("写入的 Agent Core 会话无法解压校验。", { cause: error, code: "NATIVE_SESSION_INVALID" });
    }
    offset += frameLength;
  }
  if (!output.length) {
    throw new LegacyMigrationError("写入的 Agent Core 会话为空。", { code: "NATIVE_SESSION_INVALID" });
  }
  return Buffer.concat(output);
}

export function nativeAgentSessionArtifact({ projectRoot, sessionId, transcript } = {}) {
  const id = validSessionId(sessionId);
  const root = clean(projectRoot);
  if (!id || !root || !path.isAbsolute(root)) {
    throw new LegacyMigrationError("原生 Agent 会话缺少有效的联系人工作目录或会话标识。", { code: "INVALID_NATIVE_SESSION" });
  }
  const normalizedTranscript = plainObject(transcript);
  const events = Array.isArray(normalizedTranscript.events) ? normalizedTranscript.events : [];
  if (!events.length) throw new LegacyMigrationError("原生 Agent 会话不能写入空历史。", { code: "EMPTY_NATIVE_SESSION" });
  const header = {
    version: 0,
    id,
    createdAt: Number.isFinite(Number(normalizedTranscript.createdAt))
      ? Number(normalizedTranscript.createdAt)
      : Date.now(),
    cwd: path.resolve(root),
    delegationDepth: 0,
    agentPreset: "suzu-companion",
  };
  // Use the actual vendored Agent Core validator before any source data is
  // deleted. This guards against writing a merely plausible JSONL shape.
  Session.fromRestore(id, events, header);
  const headerLine = `${JSON.stringify({ type: "session", ...header })}\n`;
  const eventLines = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(headerLine, "utf8"), ZSTD_CHECKSUM_OPTIONS),
    zstdCompressSync(Buffer.from(eventLines, "utf8"), ZSTD_CHECKSUM_OPTIONS),
  ]);
  return { bytes, events, header };
}

export function parseNativeAgentSessionArtifact(bytes, { sessionId, projectRoot } = {}) {
  const source = decompressZstdFrameSequence(bytes).toString("utf8");
  const lines = source.split(/\r?\n/u).filter(Boolean);
  let header;
  let events;
  try {
    header = JSON.parse(lines[0] || "{}");
    events = lines.slice(1).map((line) => JSON.parse(line));
  } catch (error) {
    throw new LegacyMigrationError("写入的 Agent Core 会话不是有效 JSONL。", { cause: error, code: "NATIVE_SESSION_INVALID" });
  }
  if (header.type !== "session" || header.id !== sessionId || !samePath(header.cwd, projectRoot)) {
    throw new LegacyMigrationError("写入的 Agent Core 会话头校验失败。", { code: "NATIVE_SESSION_INVALID" });
  }
  Session.fromRestore(sessionId, events, {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    delegationDepth: header.delegationDepth,
    agentPreset: header.agentPreset,
  });
  return { header, events };
}

function stripLegacyAbilityReference(bytes) {
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) return bytes;
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/u);
  const next = lines.filter((line) => line.trim() !== "@abilities.md");
  return Buffer.from(`${bom}${next.join(eol)}`, "utf8");
}

function removeManagedAbilitiesBlock(content) {
  const start = "<!-- suzu-lives:abilities:start -->";
  const end = "<!-- suzu-lives:abilities:end -->";
  const first = content.indexOf(start);
  const last = content.indexOf(end);
  if (first < 0 && last < 0) return { changed: false, content };
  if (first < 0 || last < first) return { changed: false, content, warning: "旧 abilities.md 的受管标记不完整，已保留。" };
  const before = content.slice(0, first).replace(/[ \t]*\r?\n?$/u, "");
  const after = content.slice(last + end.length).replace(/^\r?\n[ \t]*/u, "");
  const separator = before && after ? "\n\n" : "";
  return { changed: true, content: `${before}${separator}${after}` };
}

function managedHook(value) {
  const hook = plainObject(value);
  if (hook.type !== "command" || !Array.isArray(hook.args)) return false;
  if (hook.args[0] === "--suzu-lives-hook" && LEGACY_HOOK_ROLES.has(clean(hook.args[1]))) return true;
  const commandIndex = hook.args.indexOf("-Command");
  const script = commandIndex >= 0 ? hook.args[commandIndex + 1] : "";
  return clean(hook.command).toLowerCase() === "powershell.exe"
    && typeof script === "string"
    && [...LEGACY_HOOK_ROLES].some((role) => script.includes(`suzu-lives:project-hook:${role}`));
}

function directLegacyClaudeSkillId(directoryName, bytes) {
  const id = clean(directoryName).toLowerCase();
  if (!LEGACY_DIRECT_CLAUDE_SKILL_IDS.has(id)) return "";
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) return "";
  return content.includes(`<!-- suzu-lives:ability:${id} -->`) ? id : "";
}

function unmappedLegacyClaudeSkillId(directoryName, bytes) {
  const id = clean(directoryName).toLowerCase();
  if (!LEGACY_UNMAPPED_CLAUDE_SKILL_IDS.has(id)) return "";
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) return "";
  return content.includes(`<!-- suzu-lives:ability:${id} -->`) ? id : "";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function externalCapabilityId(value) {
  const id = clean(value).toLowerCase();
  return EXTERNAL_CAPABILITY_ID_PATTERN.test(id) ? id : "";
}

function safeExternalSkillRelativePath(value) {
  const source = typeof value === "string" ? value : "";
  if (!source || source.length > 1_000 || /[\r\n\0]/u.test(source) || source.includes("\\")
    || path.posix.isAbsolute(source) || path.win32.isAbsolute(source)) return "";
  const parts = source.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts.length > 17) return "";
  return source === ".suzu-lives-external-capability.json" ? "" : source;
}

function externalMcpServerName(id) {
  return `suzu-external-${id}`;
}

function jsonHash(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

function externalSkillFilesFromMetadata(value, capabilityId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyMigrationError("旧版外部 Skill 的受管标记不是对象。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
  }
  const schemaVersion = Number(value.schemaVersion);
  let rawFiles;
  if (schemaVersion === 1) {
    if (clean(value.capabilityId) && externalCapabilityId(value.capabilityId) !== capabilityId) {
      throw new LegacyMigrationError("旧版外部 Skill 的受管标记与能力 ID 不一致。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
    }
    rawFiles = value.files;
    if (!rawFiles || typeof rawFiles !== "object" || Array.isArray(rawFiles)) {
      rawFiles = { "SKILL.md": clean(value.contentSha256) };
    }
  } else if (schemaVersion === 2) {
    if (externalCapabilityId(value.capabilityId) !== capabilityId) {
      throw new LegacyMigrationError("旧版外部 Skill 的受管标记与能力 ID 不一致。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
    }
    rawFiles = value.files;
  } else {
    throw new LegacyMigrationError("旧版外部 Skill 的受管标记版本不受支持。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
  }
  if (!rawFiles || typeof rawFiles !== "object" || Array.isArray(rawFiles)) {
    throw new LegacyMigrationError("旧版外部 Skill 的受管文件列表无效。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
  }
  const files = [];
  for (const [relativePath, rawHash] of Object.entries(rawFiles)) {
    const relative = safeExternalSkillRelativePath(relativePath);
    const hash = clean(rawHash).toLowerCase();
    if (!relative || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new LegacyMigrationError("旧版外部 Skill 的受管文件列表包含无效项。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
    }
    files.push({ relativePath: relative, hash });
  }
  if (!files.length || !files.some((file) => file.relativePath === "SKILL.md")) {
    throw new LegacyMigrationError("旧版外部 Skill 的受管文件列表不完整。", { code: "EXTERNAL_SKILL_METADATA_INVALID" });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function externalMcpOwnershipFromMetadata(value, capabilityId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Number(value.schemaVersion) !== 1
    || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
    throw new LegacyMigrationError("旧版外部 MCP 的受管标记格式无效。", { code: "EXTERNAL_MCP_METADATA_INVALID" });
  }
  const entry = value.entries[capabilityId];
  if (entry === undefined) return null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || clean(entry.serverName) !== externalMcpServerName(capabilityId)
    || !/^[a-f0-9]{64}$/u.test(clean(entry.configurationSha256).toLowerCase())) {
    throw new LegacyMigrationError("旧版外部 MCP 的受管条目无效。", { code: "EXTERNAL_MCP_METADATA_INVALID" });
  }
  return {
    serverName: externalMcpServerName(capabilityId),
    configurationSha256: clean(entry.configurationSha256).toLowerCase(),
  };
}

function namedApiStore(value) {
  const source = plainObject(value);
  if (!Array.isArray(source.connections) || !plainObject(source.bindings)) {
    throw new LegacyMigrationError("新版 API 连接文件格式无效，已保留旧连接。", { code: "NAMED_CONNECTIONS_INVALID" });
  }
  return {
    version: 1,
    connections: source.connections.filter((item) => plainObject(item)),
    bindings: { ...source.bindings },
  };
}

function normalizedHttpUrl(value) {
  const source = clean(value).replace(/\/+$/u, "");
  try {
    const parsed = new URL(source);
    return ["http:", "https:"].includes(parsed.protocol) ? source : "";
  } catch {
    return "";
  }
}

function uniqueConnectionId(store, desired) {
  const base = clean(desired).replace(/[^a-z0-9-]/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase() || "legacy-api";
  const existing = new Set(store.connections.map((connection) => clean(connection.id)));
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 60)}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new LegacyMigrationError("无法为旧 API 连接生成未占用标识。", { code: "CONNECTION_ID_EXHAUSTED" });
}

function publicContactPlan(contact) {
  return {
    id: contact.id,
    name: contact.name,
    projectRoot: contact.projectRoot,
    hasLegacyInstructions: contact.hasLegacyInstructions,
    hasLegacyApprovalMode: contact.hasLegacyApprovalMode,
    transcript: contact.transcript,
    compactor: contact.compactor,
    longTermMemory: contact.longTermMemory,
  };
}

/**
 * One-time importer for the publicly released Claude-backed builds. It never
 * scans arbitrary Claude projects: every old JSONL path is derived from one
 * Suzu-owned contact directory and its fixed session id.
 */
export function createLegacyMigrationService({
  dataRoot,
  settingsService = null,
  homeDirectory = os.homedir(),
  fsOps = fs,
  adoptExternalCapabilities = null,
  now = () => new Date(),
} = {}) {
  const root = clean(dataRoot);
  if (!root || !path.isAbsolute(root)) {
    throw new LegacyMigrationError("迁移助手无法定位 Suzu Lives 数据目录。", { code: "DATA_ROOT_REQUIRED" });
  }
  const resolvedDataRoot = path.resolve(root);
  const runtimeHome = resolveSuzuAgentRuntimePaths({ dataRoot: resolvedDataRoot }).runtimeHome;
  const legacyHome = path.resolve(clean(homeDirectory) || os.homedir());

  const settingsPath = path.join(resolvedDataRoot, "settings.json");

  const readRawSettings = async () => {
    try {
      return await readJsonFileIfPresent(fsOps, settingsPath, "Suzu 设置文件");
    } catch (error) {
      if (error instanceof LegacyMigrationError && error.code === "INVALID_JSON") {
        return { exists: true, path: settingsPath, value: null, invalid: true };
      }
      throw error;
    }
  };

  const contactsRootFor = async (rawSettings) => {
    const configured = clean(plainObject(rawSettings?.value).contactsRoot);
    const selected = configured && path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.join(resolvedDataRoot, "contacts");
    return ordinaryDirectoryIfPresent(fsOps, selected, "旧版联系人根目录");
  };

  const sourceTranscriptPaths = async (contact) => {
    if (!contact.sessionId) return { paths: [], unsafe: [] };
    const paths = [];
    const unsafe = [];
    for (const directory of legacyClaudeProjectDirectoryCandidates({
      projectRoot: contact.projectRoot,
      homeDirectory: legacyHome,
    })) {
      const target = path.join(directory, `${contact.sessionId}.jsonl`);
      const stat = await lstatIfPresent(fsOps, target);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        unsafe.push(target);
        continue;
      }
      paths.push(target);
    }
    return { paths: [...new Set(paths.map((item) => path.resolve(item)))], unsafe };
  };

  const inspectContacts = async (rawSettings) => {
    const contactsRoot = await contactsRootFor(rawSettings);
    if (!contactsRoot) return { contactsRoot: "", contacts: [], errors: [] };
    let entries;
    try {
      entries = await fsOps.readdir(contactsRoot, { withFileTypes: true });
    } catch (error) {
      throw new LegacyMigrationError(`无法读取旧版联系人根目录：${clean(error?.message) || "未知错误"}`, { cause: error, code: "CONTACTS_READ_FAILED" });
    }
    const contacts = [];
    const errors = [];
    for (const entry of entries) {
      const id = validContactId(entry.name);
      if (!id || !entry.isDirectory()) continue;
      try {
        const projectPath = path.resolve(contactsRoot, id);
        if (!isInside(contactsRoot, projectPath) || !samePath(path.dirname(projectPath), contactsRoot)) continue;
        const projectStat = await lstatIfPresent(fsOps, projectPath);
        if (!projectStat || projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
          errors.push({ id, message: "联系人目录不是安全的普通文件夹，已跳过。" });
          continue;
        }
        const projectRoot = await fsOps.realpath(projectPath);
        if (!samePath(path.dirname(projectRoot), contactsRoot)) {
          errors.push({ id, message: "联系人目录解析后离开了联系人根目录，已跳过。" });
          continue;
        }
        const metadata = await readJsonFileIfPresent(
          fsOps,
          path.join(projectRoot, ".suzu-lives", "contact.json"),
          `联系人 ${id} 的元数据`,
        );
        const value = plainObject(metadata.value);
        if (!metadata.exists || validContactId(value.id) !== id) continue;
        const agentId = validAgentId(value.agentId);
        if (!agentId) {
          errors.push({ id, message: "联系人没有有效的固定 Agent 身份，已保留原数据。" });
          continue;
        }
        const sessionId = validSessionId(value.sessionId);
        const claudeInstructions = await ordinaryFileIfPresent(fsOps, path.join(projectRoot, "CLAUDE.md"), `联系人 ${id} 的 CLAUDE.md`);
        const suzuInstructions = await ordinaryFileIfPresent(fsOps, path.join(projectRoot, "SUZU.md"), `联系人 ${id} 的 SUZU.md`);
        const transcriptPaths = await sourceTranscriptPaths({ projectRoot, sessionId });
        const sessionPaths = sessionId
          ? resolveAgentSessionStoragePaths({ runtimeHome, projectRoot, sessionId })
          : null;
        const nativeArtifact = sessionPaths
          ? await ordinaryFileIfPresent(fsOps, path.join(sessionPaths.sessionDirectory, "session.jsonl.zstd"), "新版 Agent Core 会话")
          : { exists: false };
        const oldCompactor = sessionId
          ? await ordinaryFileIfPresent(
            fsOps,
            path.join(resolvedDataRoot, "agents", agentId, "conversations", sessionId, "compactor.json"),
            `联系人 ${id} 的旧压缩器设置`,
          )
          : { exists: false };
        const currentCompactor = await ordinaryFileIfPresent(
          fsOps,
          path.join(projectRoot, ".suzu-lives", "compactor.json"),
          `联系人 ${id} 的新版压缩器设置`,
        );
        const memoryDatabase = sessionId
          ? await ordinaryFileIfPresent(
            fsOps,
            path.join(resolvedDataRoot, "agents", agentId, "memory", "sessions", sessionId, "suzu-memory.db"),
            `联系人 ${id} 的长期记忆数据库`,
          )
          : { exists: false };
        contacts.push({
          id,
          name: clean(value.name) || id,
          projectRoot,
          agentId,
          sessionId,
          metadataPath: metadata.path,
          hasLegacyApprovalMode: Object.hasOwn(value, "approvalMode"),
          hasLegacyInstructions: claudeInstructions.exists,
          hasSuzuInstructions: suzuInstructions.exists,
          transcript: {
            status: !sessionId ? "missing-session-id"
              : transcriptPaths.unsafe.length ? "unsafe-source"
                : nativeArtifact.exists && transcriptPaths.paths.length ? "target-exists"
                  : nativeArtifact.exists ? "already-native"
                    : transcriptPaths.paths.length ? "ready" : "missing",
            sourcePaths: transcriptPaths.paths,
            unsafeSourcePaths: transcriptPaths.unsafe,
            targetPath: sessionPaths ? path.join(sessionPaths.sessionDirectory, "session.jsonl.zstd") : "",
          },
          compactor: {
            status: oldCompactor.exists ? (currentCompactor.exists ? "target-exists" : "ready") : "missing",
            sourcePath: oldCompactor.exists ? oldCompactor.path : "",
            targetPath: path.join(projectRoot, ".suzu-lives", "compactor.json"),
          },
          longTermMemory: {
            status: memoryDatabase.exists ? "already-compatible" : "missing",
            path: memoryDatabase.exists ? memoryDatabase.path : "",
          },
        });
      } catch (error) {
        errors.push({ id, message: clean(error?.message) || "无法检查该联系人。" });
      }
    }
    return { contactsRoot, contacts, errors };
  };

  const inspectConnections = async () => {
    const connectionsRoot = path.join(resolvedDataRoot, "connections");
    const items = [];
    for (const [id, fileName, configPath, type] of [
      ["dashscope", "dashscope.json", "", "dashscope"],
      ["image-vision", "image-vision.json", path.join(resolvedDataRoot, "capabilities", "image-vision", "config.json"), "openai-compatible"],
      ["video-understanding", "video-understanding.json", path.join(resolvedDataRoot, "capabilities", "video-understanding", "config.json"), "openai-compatible"],
    ]) {
      const sourcePath = path.join(connectionsRoot, fileName);
      try {
        const source = await readJsonFileIfPresent(fsOps, sourcePath, `旧版 ${id} 连接`);
        if (!source.exists) continue;
        items.push({
          id,
          sourcePath,
          configPath,
          type,
          encrypted: Boolean(clean(plainObject(source.value).encryptedApiKey)),
          status: clean(plainObject(source.value).encryptedApiKey) ? "ready" : "missing-credential",
        });
      } catch (error) {
        items.push({ id, sourcePath, configPath, type, encrypted: false, status: "invalid", message: clean(error?.message) || "旧连接格式无效。" });
      }
    }
    return items;
  };

  const inspect = async () => {
    const rawSettings = await readRawSettings();
    const contacts = await inspectContacts(rawSettings);
    const connections = await inspectConnections();
    const settings = plainObject(rawSettings.value);
    const legacySettingsKeys = [...LEGACY_SETTINGS_KEYS].filter((key) => Object.hasOwn(settings, key));
    const externalRegistry = await ordinaryFileIfPresent(
      fsOps,
      path.join(resolvedDataRoot, "external-capabilities", "registry.json"),
      "外部能力登记",
    );
    const hasMigratableContact = contacts.contacts.some((contact) => (
      contact.hasLegacyInstructions || contact.hasLegacyApprovalMode || contact.transcript.status === "ready" || contact.compactor.status === "ready"
    ));
    const hasWork = hasMigratableContact || legacySettingsKeys.length > 0 || connections.some((item) => item.status === "ready") || externalRegistry.exists;
    return {
      status: hasWork ? "ready" : "none",
      dataRoot: resolvedDataRoot,
      contactsRoot: contacts.contactsRoot,
      legacySettingsKeys,
      externalCapabilities: {
        status: externalRegistry.exists ? "eligible" : "missing",
        registryPath: externalRegistry.exists ? externalRegistry.path : "",
      },
      connections,
      contacts: contacts.contacts.map(publicContactPlan),
      errors: contacts.errors,
      totals: {
        contacts: contacts.contacts.length,
        contactInstructions: contacts.contacts.filter((contact) => contact.hasLegacyInstructions).length,
        nativeTranscriptImports: contacts.contacts.filter((contact) => contact.transcript.status === "ready").length,
        compatibleMemoryDatabases: contacts.contacts.filter((contact) => contact.longTermMemory.status === "already-compatible").length,
        connections: connections.filter((item) => item.status === "ready").length,
      },
      notes: [
        "旧 Claude JSONL 会转换为本地 Agent Core 原生会话；成功校验后才删除对应的、由该联系人会话标识精确定位的 JSONL。",
        "旧版长期记忆数据库与新版仍使用同一联系人和会话路径，因此会原样保留，不复制也不清空。",
        "旧 Claude 登录状态不会读取、迁移或删除；请在新版的“主模型”中单独配置所用模型服务和 API Key。",
      ],
    };
  };

  const migrateContactInstructions = async (contact) => {
    const sourcePath = path.join(contact.projectRoot, "CLAUDE.md");
    const targetPath = path.join(contact.projectRoot, "SUZU.md");
    const source = await ordinaryFileIfPresent(fsOps, sourcePath, `联系人 ${contact.name} 的 CLAUDE.md`);
    const target = await ordinaryFileIfPresent(fsOps, targetPath, `联系人 ${contact.name} 的 SUZU.md`);
    if (!source.exists) return { status: target.exists ? "already-current" : "missing" };
    const abilities = await ordinaryFileIfPresent(fsOps, path.join(contact.projectRoot, "abilities.md"), `联系人 ${contact.name} 的 abilities.md`);
    const hasManagedAbilities = abilities.exists && abilities.bytes.toString("utf8").includes("<!-- suzu-lives:abilities:start -->");
    const expected = hasManagedAbilities ? stripLegacyAbilityReference(source.bytes) : source.bytes;
    if (target.exists) {
      if (!target.bytes.equals(expected)) return { status: "conflict", sourcePath, targetPath };
      await removeRegularFileAfterHash(fsOps, sourcePath, sha256(source.bytes), `联系人 ${contact.name} 的旧 CLAUDE.md`);
      return { status: "already-identical", sourcePath, targetPath };
    }
    await writeBytesAtomically(fsOps, targetPath, expected, `联系人 ${contact.name} 的 SUZU.md`);
    await removeRegularFileAfterHash(fsOps, sourcePath, sha256(source.bytes), `联系人 ${contact.name} 的旧 CLAUDE.md`);
    return { status: "migrated", sourcePath, targetPath };
  };

  const removeLegacyApprovalMode = async (contact) => {
    const metadata = await readJsonFileIfPresent(fsOps, contact.metadataPath, `联系人 ${contact.name} 的元数据`);
    if (!metadata.exists || !Object.hasOwn(metadata.value, "approvalMode")) return { status: "unchanged" };
    const next = { ...metadata.value };
    delete next.approvalMode;
    await replaceBytesAtomically(
      fsOps,
      metadata.path,
      sha256(metadata.bytes),
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"),
      `联系人 ${contact.name} 的新版元数据`,
    );
    return { status: "removed" };
  };

  const cleanupLegacyClaudeArtifacts = async (contact) => {
    const result = { abilities: "unchanged", hooks: "unchanged", skillsRemoved: 0, warnings: [] };
    const abilitiesPath = path.join(contact.projectRoot, "abilities.md");
    try {
      const abilities = await ordinaryFileIfPresent(fsOps, abilitiesPath, `联系人 ${contact.name} 的 abilities.md`);
      if (abilities.exists) {
        const content = abilities.bytes.toString("utf8");
        if (Buffer.from(content, "utf8").equals(abilities.bytes)) {
          const next = removeManagedAbilitiesBlock(content);
          if (next.warning) result.warnings.push(next.warning);
          if (next.changed) {
            if (!next.content.trim()) {
              await removeRegularFileAfterHash(fsOps, abilities.path, sha256(abilities.bytes), `联系人 ${contact.name} 的旧 abilities.md`);
            } else {
              await replaceBytesAtomically(
                fsOps,
                abilities.path,
                sha256(abilities.bytes),
                Buffer.from(next.content, "utf8"),
                `联系人 ${contact.name} 的 abilities.md`,
              );
            }
            result.abilities = "removed-managed-block";
          }
        }
      }
    } catch (error) {
      result.warnings.push(clean(error?.message) || "旧 abilities.md 未能安全清理。 ");
    }

    const claudeDirectory = path.join(contact.projectRoot, ".claude");
    try {
      const claudeRoot = await ordinaryDirectoryIfPresent(fsOps, claudeDirectory, `联系人 ${contact.name} 的 .claude 目录`);
      if (!claudeRoot) return result;
      const settingsPath = path.join(claudeRoot, "settings.json");
      const settings = await readJsonFileIfPresent(fsOps, settingsPath, `联系人 ${contact.name} 的 Claude Hook 设置`);
      if (settings.exists && plainObject(settings.value.hooks) === settings.value.hooks) {
        const hooks = settings.value.hooks;
        let changed = false;
        const nextHooks = {};
        for (const [event, entries] of Object.entries(hooks)) {
          if (!Array.isArray(entries)) {
            nextHooks[event] = entries;
            continue;
          }
          const retainedEntries = entries.flatMap((entry) => {
            const outer = plainObject(entry);
            if (!Array.isArray(outer.hooks)) return [entry];
            const retainedHooks = outer.hooks.filter((hook) => !managedHook(hook));
            if (retainedHooks.length === outer.hooks.length) return [entry];
            changed = true;
            return retainedHooks.length ? [{ ...outer, hooks: retainedHooks }] : [];
          });
          if (retainedEntries.length) nextHooks[event] = retainedEntries;
        }
        if (changed) {
          const next = { ...settings.value };
          if (Object.keys(nextHooks).length) next.hooks = nextHooks;
          else delete next.hooks;
          await replaceBytesAtomically(
            fsOps,
            settings.path,
            sha256(settings.bytes),
            Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"),
            `联系人 ${contact.name} 的 Claude Hook 设置`,
          );
          result.hooks = "removed-managed-hooks";
        }
      }

      const skillsRoot = await ordinaryDirectoryIfPresent(fsOps, path.join(claudeRoot, "skills"), `联系人 ${contact.name} 的旧 Skill 目录`);
      if (skillsRoot) {
        const entries = await fsOps.readdir(skillsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const directory = path.join(skillsRoot, entry.name);
          const stat = await lstatIfPresent(fsOps, directory);
          if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
          const skill = await ordinaryFileIfPresent(fsOps, path.join(directory, "SKILL.md"), "旧版 Suzu Skill");
          if (!skill.exists) continue;
          const unmappedId = unmappedLegacyClaudeSkillId(entry.name, skill.bytes);
          if (unmappedId) {
            result.warnings.push(`旧能力 ${unmappedId} 在新版没有可安全接管的对应功能，已保留其 Claude Skill。`);
            continue;
          }
          if (!directLegacyClaudeSkillId(entry.name, skill.bytes)) continue;
          await removeRegularFileAfterHash(fsOps, skill.path, sha256(skill.bytes), "旧版 Suzu Skill");
          await removeDirectoryIfEmpty(fsOps, directory).catch(() => false);
          result.skillsRemoved += 1;
        }
      }
    } catch (error) {
      result.warnings.push(clean(error?.message) || "旧 Claude 项目注册未能完全清理。 ");
    }
    return result;
  };

  const migrateLegacyCompactor = async (contact) => {
    if (!contact.sessionId) return { status: "missing-session-id" };
    const sourcePath = path.join(resolvedDataRoot, "agents", contact.agentId, "conversations", contact.sessionId, "compactor.json");
    const targetPath = path.join(contact.projectRoot, ".suzu-lives", "compactor.json");
    const source = await readJsonFileIfPresent(fsOps, sourcePath, `联系人 ${contact.name} 的旧压缩器设置`);
    if (!source.exists) return { status: "missing" };
    const target = await ordinaryFileIfPresent(fsOps, targetPath, `联系人 ${contact.name} 的新版压缩器设置`);
    if (target.exists) return { status: "target-exists", sourcePath, targetPath };
    const automatic = plainObject(source.value.automatic);
    const manual = plainObject(source.value.manual);
    const next = {
      // The current Agent Core keeps the compact v1 shape. The public 0.1.x file had
      // extra trigger/time fields; do not carry fields the new service no
      // longer owns into its configuration.
      version: 1,
      prompt: clean(source.value.prompt),
      automatic: {
        enabled: automatic.enabled === true,
        tokenThreshold: Number.isSafeInteger(automatic.tokenThreshold) && automatic.tokenThreshold > 0 ? automatic.tokenThreshold : 15_000,
        retainTokens: Number.isSafeInteger(automatic.retainTokens) && automatic.retainTokens > 0 ? automatic.retainTokens : 5_000,
      },
      manual: {
        retainTokens: Number.isSafeInteger(manual.retainTokens) && manual.retainTokens > 0 ? manual.retainTokens : 5_000,
      },
      updatedAt: clean(source.value.updatedAt) || new Date(now()).toISOString(),
    };
    await writeBytesAtomically(fsOps, targetPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"), `联系人 ${contact.name} 的新版压缩器设置`);
    await removeRegularFileAfterHash(fsOps, source.path, sha256(source.bytes), `联系人 ${contact.name} 的旧压缩器设置`);
    return { status: "migrated", sourcePath, targetPath };
  };

  const migrateLegacyTranscript = async (contact) => {
    if (!contact.sessionId) return { status: "missing-session-id" };
    const sources = await sourceTranscriptPaths(contact);
    if (sources.unsafe.length) return { status: "unsafe-source", sourcePaths: sources.unsafe };
    const sessionPaths = resolveAgentSessionStoragePaths({ runtimeHome, projectRoot: contact.projectRoot, sessionId: contact.sessionId });
    const targetPath = path.join(sessionPaths.sessionDirectory, "session.jsonl.zstd");
    const existingTarget = await ordinaryFileIfPresent(fsOps, targetPath, `联系人 ${contact.name} 的新版 Agent Core 会话`);
    if (existingTarget.exists) return { status: sources.paths.length ? "target-exists" : "already-native", targetPath, sourcePaths: sources.paths };
    if (!sources.paths.length) return { status: "missing" };
    const originals = [];
    for (const sourcePath of sources.paths) {
      originals.push(await ordinaryFileIfPresent(fsOps, sourcePath, `联系人 ${contact.name} 的旧 Claude JSONL`, { maximumBytes: MAX_LEGACY_TRANSCRIPT_BYTES }));
    }
    const hashes = new Set(originals.map((source) => sha256(source.bytes)));
    if (hashes.size !== 1) return { status: "duplicate-conflict", sourcePaths: sources.paths, targetPath };
    const fallbackTime = originals[0].exists ? Math.round((await fsOps.lstat(originals[0].path)).mtimeMs) : Date.now();
    const transcript = legacyClaudeTranscriptEvents({ bytes: originals[0].bytes, fallbackTime, sessionId: contact.sessionId });
    const artifact = nativeAgentSessionArtifact({
      projectRoot: contact.projectRoot,
      sessionId: contact.sessionId,
      transcript,
    });
    await ensureOrdinaryDirectory(fsOps, sessionPaths.sessionDirectory, `联系人 ${contact.name} 的新版 Agent Core 会话目录`);
    const entries = await fsOps.readdir(sessionPaths.sessionDirectory);
    if (entries.length) return { status: "target-directory-not-empty", targetPath, sourcePaths: sources.paths };
    await writeBytesAtomically(fsOps, targetPath, artifact.bytes, `联系人 ${contact.name} 的新版 Agent Core 会话`);
    const written = await ordinaryFileIfPresent(fsOps, targetPath, `联系人 ${contact.name} 的新版 Agent Core 会话`);
    parseNativeAgentSessionArtifact(written.bytes, { sessionId: contact.sessionId, projectRoot: contact.projectRoot });
    // A malformed legacy line cannot be faithfully represented in the native
    // history. Keep the original JSONL in that case even though every valid
    // conversational message has been imported; deletion is reserved for a
    // fully parsed source only.
    if (transcript.malformedLines) {
      return {
        status: "migrated-with-retained-source",
        targetPath,
        sourcePaths: sources.paths,
        sourceFilesRemoved: 0,
        messageCount: transcript.messageCount,
        malformedLines: transcript.malformedLines,
      };
    }
    const sourceHash = hashes.values().next().value;
    let removed = 0;
    for (const source of originals) {
      if (await removeRegularFileAfterHash(fsOps, source.path, sourceHash, `联系人 ${contact.name} 的旧 Claude JSONL`)) removed += 1;
    }
    return {
      status: "migrated",
      targetPath,
      sourcePaths: sources.paths,
      sourceFilesRemoved: removed,
      messageCount: transcript.messageCount,
      malformedLines: transcript.malformedLines,
    };
  };

  const readNamedConnectionStore = async () => {
    const location = path.join(resolvedDataRoot, "connections", "api-connections.json");
    const stored = await readJsonFileIfPresent(fsOps, location, "新版 API 连接文件");
    if (!stored.exists) return { path: location, bytes: Buffer.alloc(0), store: { version: 1, connections: [], bindings: {} }, exists: false };
    return { path: stored.path, bytes: stored.bytes, store: namedApiStore(stored.value), exists: true };
  };

  const writeNamedConnectionStore = async (current, store) => {
    const targetParent = path.dirname(current.path);
    await ensureOrdinaryDirectory(fsOps, targetParent, "新版 API 连接目录");
    const payload = Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    if (current.exists) {
      await replaceBytesAtomically(fsOps, current.path, sha256(current.bytes), payload, "新版 API 连接文件");
      return current.path;
    }
    await writeBytesAtomically(fsOps, current.path, payload, "新版 API 连接文件");
    return current.path;
  };

  const connectionFor = (store, { encryptedApiKey, baseUrl, type, name, model = "" }) => {
    const existing = store.connections.find((item) => (
      clean(item.type) === type
      && clean(item.encryptedApiKey) === encryptedApiKey
      && clean(item.baseUrl).replace(/\/+$/u, "") === baseUrl
      // An OpenAI-compatible connection's model is part of its usable
      // identity. Image understanding and video understanding may share a
      // key and endpoint while deliberately selecting different models.
      && (type !== "openai-compatible" || clean(item.model) === model)
    ));
    if (existing) return { connection: existing, created: false };
    const connection = {
      id: uniqueConnectionId(store, `legacy-${type}`),
      name,
      type,
      baseUrl,
      model,
      encryptedApiKey,
      generationEndpoint: type === "openai-compatible" ? "/images/generations" : "",
      editEndpoint: type === "openai-compatible" ? "/images/edits" : "",
      quality: "",
      outputFormat: "",
      inputFidelity: "",
      extraBody: {},
      editExtraBody: {},
      timeoutMs: type === "openai-compatible" ? 180_000 : 0,
    };
    store.connections.push(connection);
    return { connection, created: true };
  };

  const removeLegacyCapabilityProvider = async ({ id, configPath }) => {
    const field = id === "image-vision" ? "openai" : id === "video-understanding" ? "provider" : "";
    if (!field || !configPath) return { status: "not-applicable" };
    const configuration = await readJsonFileIfPresent(fsOps, configPath, `旧版 ${id} 能力配置`);
    if (!configuration.exists) return { status: "already-current" };
    const next = { ...configuration.value };
    let changed = false;
    if (Object.hasOwn(next, field)) {
      delete next[field];
      changed = true;
    }
    // 0.1.x also allowed the image-specific block to override the shared
    // connection's endpoint/model. They are now represented by the named
    // connection written above, so keep only the current image-tuning fields.
    if (id === "image-vision" && next.vision && typeof next.vision === "object" && !Array.isArray(next.vision)) {
      const vision = { ...next.vision };
      for (const key of ["baseUrl", "base_url", "model"]) {
        if (!Object.hasOwn(vision, key)) continue;
        delete vision[key];
        changed = true;
      }
      next.vision = vision;
    }
    if (!changed) return { status: "already-current" };
    await replaceBytesAtomically(
      fsOps,
      configuration.path,
      sha256(configuration.bytes),
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"),
      `新版 ${id} 能力配置`,
    );
    return { status: "removed-legacy-provider", path: configuration.path, field };
  };

  const migrateLegacyConnection = async ({ id, sourcePath, configPath, type }) => {
    const source = await readJsonFileIfPresent(fsOps, sourcePath, `旧版 ${id} 连接`);
    if (!source.exists) return { id, status: "missing" };
    const encryptedApiKey = clean(source.value.encryptedApiKey);
    if (!encryptedApiKey) return { id, status: "missing-credential", sourcePath };
    let baseUrl = "";
    let model = "";
    let name = "";
    let bindings = [];
    if (id === "dashscope") {
      baseUrl = normalizedHttpUrl(source.value.baseUrl || "https://dashscope.aliyuncs.com/api/v1");
      name = "旧版阿里百炼";
      bindings = ["image-workbench", "image-generation", "phone-camera", "voice-message"];
    } else {
      const configuration = await readJsonFileIfPresent(fsOps, configPath, `旧版 ${id} 能力配置`);
      if (!configuration.exists) return { id, status: "needs-manual-configuration", sourcePath, message: "找不到旧版能力的服务地址和模型设置，已保留密钥文件。" };
      const config = plainObject(configuration.value);
      const provider = id === "image-vision"
        ? { ...plainObject(config.openai), ...plainObject(config.vision) }
        : { ...plainObject(config.provider), ...plainObject(config.video) };
      baseUrl = normalizedHttpUrl(provider.baseUrl || provider.base_url);
      model = clean(provider.model);
      name = id === "image-vision" ? "旧版图像理解" : "旧版视频理解";
      bindings = [id];
      if (!baseUrl || !model) {
        return { id, status: "needs-manual-configuration", sourcePath, message: "旧版能力缺少可验证的服务地址或模型，已保留密钥文件。" };
      }
    }
    if (!baseUrl) return { id, status: "invalid-base-url", sourcePath };
    const current = await readNamedConnectionStore();
    const store = structuredClone(current.store);
    const selected = connectionFor(store, { encryptedApiKey, baseUrl, type, name, model });
    for (const feature of bindings) {
      if (!clean(store.bindings[feature])) store.bindings[feature] = selected.connection.id;
    }
    await writeNamedConnectionStore(current, store);
    const verified = await readNamedConnectionStore();
    const match = verified.store.connections.find((item) => item.id === selected.connection.id
      && clean(item.encryptedApiKey) === encryptedApiKey
      && clean(item.baseUrl).replace(/\/+$/u, "") === baseUrl
      && (type !== "openai-compatible" || clean(item.model) === model));
    if (!match) throw new LegacyMigrationError("新版 API 连接写入后无法确认，已保留旧密钥。", { code: "CONNECTION_VERIFICATION_FAILED" });
    await removeRegularFileAfterHash(fsOps, source.path, sha256(source.bytes), `旧版 ${id} 连接`);
    let providerCleanup = { status: "not-applicable" };
    try {
      providerCleanup = await removeLegacyCapabilityProvider({ id, configPath });
    } catch (error) {
      providerCleanup = {
        status: "retained",
        message: clean(error?.message) || "旧版 provider 配置未能安全清理。",
      };
    }
    return {
      id,
      status: providerCleanup.status === "retained" ? "migrated-with-retained-provider" : "migrated",
      sourcePath,
      connectionId: selected.connection.id,
      created: selected.created,
      bindings,
      providerCleanup,
    };
  };

  const cleanupOwnedExternalSkill = async ({ projectRoot, capabilityId }) => {
    const id = externalCapabilityId(capabilityId);
    if (!id) return { type: "skill", status: "invalid-capability-id" };
    const claudeRoot = await ordinaryDirectoryIfPresent(fsOps, path.join(projectRoot, ".claude"), "旧版 Claude 项目目录");
    if (!claudeRoot) return { type: "skill", capabilityId: id, status: "missing" };
    const skillsRoot = await ordinaryDirectoryIfPresent(fsOps, path.join(claudeRoot, "skills"), "旧版 Claude Skill 目录");
    if (!skillsRoot) return { type: "skill", capabilityId: id, status: "missing" };
    const folder = await ordinaryDirectoryIfPresent(fsOps, path.join(skillsRoot, `suzu-external-${id}`), "旧版外部 Skill 目录");
    if (!folder) return { type: "skill", capabilityId: id, status: "missing" };
    const metadataPath = path.join(folder, ".suzu-lives-external-capability.json");
    const metadata = await readJsonFileIfPresent(fsOps, metadataPath, "旧版外部 Skill 受管标记");
    if (!metadata.exists) {
      return { type: "skill", capabilityId: id, status: "retained", message: "外部 Skill 缺少 Suzu 所有权标记，未删除。" };
    }
    let files;
    try {
      files = externalSkillFilesFromMetadata(metadata.value, id);
    } catch (error) {
      return { type: "skill", capabilityId: id, status: "retained", message: clean(error?.message) || "外部 Skill 受管标记无效，未删除。" };
    }
    const ownedFiles = [];
    try {
      for (const file of files) {
        const segments = file.relativePath.split("/");
        let parent = folder;
        for (const segment of segments.slice(0, -1)) {
          parent = path.join(parent, segment);
          const stat = await lstatIfPresent(fsOps, parent);
          if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new LegacyMigrationError(`旧版外部 Skill 文件 ${file.relativePath} 的目录不安全。`, { code: "UNSAFE_EXTERNAL_SKILL" });
          }
        }
        const target = path.resolve(folder, ...segments);
        if (!isInside(folder, target)) {
          throw new LegacyMigrationError("旧版外部 Skill 文件超出能力目录。", { code: "UNSAFE_EXTERNAL_SKILL" });
        }
        const source = await ordinaryFileIfPresent(fsOps, target, `旧版外部 Skill 文件 ${file.relativePath}`);
        if (!source.exists || sha256(source.bytes) !== file.hash) {
          throw new LegacyMigrationError(`旧版外部 Skill 文件 ${file.relativePath} 已被修改，未删除。`, { code: "EXTERNAL_SKILL_MODIFIED" });
        }
        ownedFiles.push({ ...file, path: source.path });
      }
    } catch (error) {
      return { type: "skill", capabilityId: id, status: "retained", message: clean(error?.message) || "无法验证旧版外部 Skill，未删除。" };
    }
    for (const file of ownedFiles) {
      await removeRegularFileAfterHash(fsOps, file.path, file.hash, `旧版外部 Skill 文件 ${file.relativePath}`);
    }
    await removeRegularFileAfterHash(fsOps, metadata.path, sha256(metadata.bytes), "旧版外部 Skill 受管标记");
    const parents = [...new Set(ownedFiles.map((file) => path.dirname(file.path)))]
      .sort((left, right) => right.length - left.length);
    for (const parent of parents) await removeDirectoryIfEmpty(fsOps, parent).catch(() => false);
    await removeDirectoryIfEmpty(fsOps, folder).catch(() => false);
    return { type: "skill", capabilityId: id, status: "removed", filesRemoved: ownedFiles.length };
  };

  const cleanupOwnedExternalMcp = async ({ projectRoot, capabilityId }) => {
    const id = externalCapabilityId(capabilityId);
    if (!id) return { type: "mcp", status: "invalid-capability-id" };
    const claudeRoot = await ordinaryDirectoryIfPresent(fsOps, path.join(projectRoot, ".claude"), "旧版 Claude 项目目录");
    if (!claudeRoot) return { type: "mcp", capabilityId: id, status: "missing" };
    const metadataPath = path.join(claudeRoot, "suzu-lives-external-capabilities.json");
    const metadata = await readJsonFileIfPresent(fsOps, metadataPath, "旧版外部 MCP 受管标记");
    if (!metadata.exists) return { type: "mcp", capabilityId: id, status: "missing" };
    let ownership;
    try {
      ownership = externalMcpOwnershipFromMetadata(metadata.value, id);
    } catch (error) {
      return { type: "mcp", capabilityId: id, status: "retained", message: clean(error?.message) || "外部 MCP 受管标记无效，未删除。" };
    }
    if (!ownership) return { type: "mcp", capabilityId: id, status: "missing" };

    const mcpPath = path.join(projectRoot, ".mcp.json");
    let serverRemoved = false;
    try {
      const mcp = await readJsonFileIfPresent(fsOps, mcpPath, "旧版 Claude MCP 配置");
      if (mcp.exists) {
        const currentServers = mcp.value.mcpServers === undefined ? {} : mcp.value.mcpServers;
        if (!currentServers || typeof currentServers !== "object" || Array.isArray(currentServers)) {
          return { type: "mcp", capabilityId: id, status: "retained", message: "旧版 .mcp.json 的 mcpServers 格式无效，未删除。" };
        }
        if (Object.hasOwn(currentServers, ownership.serverName)) {
          if (jsonHash(currentServers[ownership.serverName]) !== ownership.configurationSha256) {
            return { type: "mcp", capabilityId: id, status: "retained", message: "旧版 MCP 条目已被手动修改，未删除。" };
          }
          const nextServers = { ...currentServers };
          delete nextServers[ownership.serverName];
          await replaceBytesAtomically(
            fsOps,
            mcp.path,
            sha256(mcp.bytes),
            Buffer.from(`${JSON.stringify({ ...mcp.value, mcpServers: nextServers }, null, 2)}\n`, "utf8"),
            "旧版 Claude MCP 配置",
          );
          serverRemoved = true;
        }
      }
    } catch (error) {
      return { type: "mcp", capabilityId: id, status: "retained", message: clean(error?.message) || "无法验证旧版 MCP 配置，未删除。" };
    }

    const nextEntries = { ...metadata.value.entries };
    delete nextEntries[id];
    const metadataHasOnlyKnownFields = Object.keys(metadata.value).every((key) => key === "schemaVersion" || key === "entries");
    if (!Object.keys(nextEntries).length && metadataHasOnlyKnownFields) {
      await removeRegularFileAfterHash(fsOps, metadata.path, sha256(metadata.bytes), "旧版外部 MCP 受管标记");
    } else {
      await replaceBytesAtomically(
        fsOps,
        metadata.path,
        sha256(metadata.bytes),
        Buffer.from(`${JSON.stringify({ ...metadata.value, entries: nextEntries }, null, 2)}\n`, "utf8"),
        "旧版外部 MCP 受管标记",
      );
    }
    return { type: "mcp", capabilityId: id, status: "removed", serverRemoved };
  };

  const cleanupAdoptedExternalCapabilities = async (adoption) => {
    const registrations = Array.isArray(adoption?.registrations) ? adoption.registrations : [];
    const cleanup = [];
    const warnings = [];
    const handled = new Set();
    for (const registration of registrations) {
      const capabilityId = externalCapabilityId(registration?.id);
      const types = new Set(Array.isArray(registration?.types) ? registration.types : []);
      const roots = Array.isArray(registration?.sourceProjectRoots) ? registration.sourceProjectRoots : [];
      if (!capabilityId) {
        warnings.push("一项已接管的外部能力没有有效 ID，旧 Claude 投影已保留。" );
        continue;
      }
      for (const root of roots) {
        const projectRoot = clean(root);
        if (!projectRoot || !path.isAbsolute(projectRoot)) {
          warnings.push(`外部能力 ${capabilityId} 的旧项目路径无效，旧 Claude 投影已保留。`);
          continue;
        }
        for (const type of ["skill", "mcp"]) {
          if (!types.has(type)) continue;
          const key = `${pathKey(projectRoot)}\u0000${capabilityId}\u0000${type}`;
          if (handled.has(key)) continue;
          handled.add(key);
          try {
            const item = type === "skill"
              ? await cleanupOwnedExternalSkill({ projectRoot, capabilityId })
              : await cleanupOwnedExternalMcp({ projectRoot, capabilityId });
            cleanup.push({ projectRoot: path.resolve(projectRoot), ...item });
            if (item.status === "retained") warnings.push(`外部能力 ${capabilityId} 的旧 ${type.toUpperCase()} 投影已保留：${item.message}`);
          } catch (error) {
            const message = clean(error?.message) || "清理失败，旧投影已保留。";
            cleanup.push({ projectRoot: path.resolve(projectRoot), type, capabilityId, status: "retained", message });
            warnings.push(`外部能力 ${capabilityId} 的旧 ${type.toUpperCase()} 投影已保留：${message}`);
          }
        }
      }
    }
    return { items: cleanup, warnings };
  };

  const migrateExternalCapabilities = async (contacts) => {
    if (typeof adoptExternalCapabilities !== "function") return { status: "not-configured" };
    const roots = contacts.map((contact) => contact.projectRoot);
    if (!roots.length) return { status: "no-contacts" };
    try {
      const result = await adoptExternalCapabilities({ legacyProjectRoots: roots });
      const cleanup = await cleanupAdoptedExternalCapabilities(result);
      return {
        ...plainObject(result),
        status: cleanup.warnings.length ? "adopted-with-retained-projections" : "adopted",
        cleanup,
      };
    } catch (error) {
      return { status: "failed", message: clean(error?.message) || "旧版外部能力未能接管。" };
    }
  };

  const migrate = async () => {
    const plan = await inspect();
    const startedAt = new Date(now()).toISOString();
    const result = {
      status: plan.status === "none" ? "nothing-to-migrate" : "completed",
      dataRoot: resolvedDataRoot,
      startedAt,
      finishedAt: "",
      contacts: [],
      connections: [],
      settings: { status: "unchanged" },
      externalCapabilities: { status: "not-configured" },
      warnings: [],
    };
    for (const sourceContact of plan.contacts) {
      const contact = (await inspectContacts(await readRawSettings())).contacts.find((item) => item.id === sourceContact.id);
      if (!contact) {
        result.warnings.push(`联系人 ${sourceContact.name} 在迁移开始前发生变化，已跳过。`);
        result.status = "partial";
        continue;
      }
      const entry = { id: contact.id, name: contact.name, instructions: null, transcript: null, compactor: null, metadata: null, cleanup: null };
      try {
        entry.instructions = await migrateContactInstructions(contact);
        // A contact may have had its old CLAUDE.md intentionally removed while
        // still retaining a Suzu-owned transcript and memory.  There is no
        // instruction-file conflict in that case, so do not strand the rest of
        // its safely identifiable data in the old layout.
        const safeForCleanup = ["migrated", "already-identical", "already-current", "missing"].includes(entry.instructions.status);
        if (safeForCleanup) {
          entry.metadata = await removeLegacyApprovalMode(contact);
          entry.cleanup = await cleanupLegacyClaudeArtifacts(contact);
          entry.compactor = await migrateLegacyCompactor(contact);
          entry.transcript = await migrateLegacyTranscript(contact);
          for (const warning of entry.cleanup.warnings || []) {
            result.status = "partial";
            result.warnings.push(`联系人 ${contact.name}：${warning}`);
          }
          if (entry.compactor.status === "target-exists") {
            result.status = "partial";
            result.warnings.push(`联系人 ${contact.name} 的旧压缩器设置已保留：新版位置已有文件，迁移助手不会覆盖它。`);
          }
          const transcriptStatus = entry.transcript.status;
          if (transcriptStatus === "migrated-with-retained-source") {
            result.status = "partial";
            result.warnings.push(`联系人 ${contact.name} 的旧 JSONL 含无法解析的记录；可读消息已导入，但原文件已保留。`);
          } else if (["target-exists", "target-directory-not-empty", "duplicate-conflict", "unsafe-source", "missing-session-id"].includes(transcriptStatus)) {
            result.status = "partial";
            result.warnings.push(`联系人 ${contact.name} 的旧 JSONL 已保留：${{
              "target-exists": "新版会话已存在，迁移助手不会猜测两者是否相同。",
              "target-directory-not-empty": "新版会话目录已有其他文件，迁移助手不会覆盖。",
              "duplicate-conflict": "发现内容不一致的旧 JSONL 副本。",
              "unsafe-source": "旧 JSONL 不是安全的普通文件。",
              "missing-session-id": "联系人缺少有效会话标识。",
            }[transcriptStatus]}`);
          }
        } else {
          entry.metadata = { status: "preserved" };
          entry.cleanup = { status: "preserved" };
          entry.compactor = { status: "preserved" };
          entry.transcript = { status: "preserved" };
          result.status = "partial";
          result.warnings.push(`联系人 ${contact.name} 的 SUZU.md 与旧 CLAUDE.md 内容冲突，未删除任何旧聊天或项目配置。`);
        }
      } catch (error) {
        result.status = "partial";
        entry.error = clean(error?.message) || "迁移该联系人时发生未知错误。";
      }
      result.contacts.push(entry);
    }

    for (const connection of [
      { id: "dashscope", sourcePath: path.join(resolvedDataRoot, "connections", "dashscope.json"), configPath: "", type: "dashscope" },
      { id: "image-vision", sourcePath: path.join(resolvedDataRoot, "connections", "image-vision.json"), configPath: path.join(resolvedDataRoot, "capabilities", "image-vision", "config.json"), type: "openai-compatible" },
      { id: "video-understanding", sourcePath: path.join(resolvedDataRoot, "connections", "video-understanding.json"), configPath: path.join(resolvedDataRoot, "capabilities", "video-understanding", "config.json"), type: "openai-compatible" },
    ]) {
      try {
        const migrated = await migrateLegacyConnection(connection);
        result.connections.push(migrated);
        if (["needs-manual-configuration", "invalid-base-url", "migrated-with-retained-provider"].includes(migrated.status)) {
          result.status = "partial";
          result.warnings.push(
            migrated.status === "migrated-with-retained-provider"
              ? `旧版 ${connection.id} 已接管，但旧 provider 配置已按安全规则保留：${migrated.providerCleanup?.message || "请在新版确认后再处理。"}`
              : `旧版 ${connection.id} 凭据已保留：${migrated.message || "需要在新版中补充服务配置。"}`,
          );
        }
      } catch (error) {
        result.status = "partial";
        result.connections.push({ id: connection.id, status: "failed", message: clean(error?.message) || "旧连接迁移失败。" });
      }
    }

    const safelyMigratedContactIds = new Set(result.contacts
      .filter((entry) => ["migrated", "already-identical", "already-current", "missing"].includes(entry.instructions?.status))
      .map((entry) => entry.id));
    result.externalCapabilities = await migrateExternalCapabilities(
      plan.contacts.filter((contact) => safelyMigratedContactIds.has(contact.id)),
    );
    if (result.externalCapabilities.status === "failed") {
      result.status = "partial";
      result.warnings.push(result.externalCapabilities.message);
    }
    if (result.externalCapabilities.status === "adopted-with-retained-projections") {
      result.status = "partial";
      result.warnings.push(...(result.externalCapabilities.cleanup?.warnings || []));
    }

    if (plan.legacySettingsKeys.length) {
      try {
        if (!settingsService?.load || !settingsService?.save) {
          throw new LegacyMigrationError("迁移助手没有可用的新版设置服务。", { code: "SETTINGS_SERVICE_REQUIRED" });
        }
        await settingsService.save(settingsService.load());
        result.settings = { status: "migrated", removedKeys: plan.legacySettingsKeys };
      } catch (error) {
        result.status = "partial";
        result.settings = { status: "failed", message: clean(error?.message) || "旧设置未能清理。" };
      }
    }
    result.finishedAt = new Date(now()).toISOString();
    return result;
  };

  return Object.freeze({ inspect, migrate });
}
