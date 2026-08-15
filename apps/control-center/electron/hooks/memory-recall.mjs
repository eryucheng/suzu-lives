import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";
import { createNamedApiConnectionService } from "@suzu-lives/service-connections";
import { createContactProjectsService } from "../services/contact-projects.mjs";
import { createLongTermMemoryService } from "../services/long-term-memory-service.mjs";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_HOOK_INPUT_LENGTH = 256 * 1024;
const MAX_USER_PROMPT_LENGTH = 20_000;
const WORKER_DIRECTORY_PREFIX = "suzu-lives-memory-hook-";
const WORKER_INPUT_FILE = "payload.json";
const WORKER_OUTPUT_FILE = "result.json";
const SCHEDULE_TASK_OPEN = "<suzu-schedule-task>";
const MERCHANT_TASK_OPEN = "<suzu-merchant-task>";
const VOICE_CALL_TURN_OPEN = "<suzu-voice-call-turn>";
const VOICE_CALL_TURN_CLOSE = "</suzu-voice-call-turn>";
const VOICE_CALL_OPEN_OPEN = "<suzu-voice-call-open>";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeSessionId(value) {
  const id = clean(value);
  return SESSION_ID_PATTERN.test(id) ? id : "";
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hookArguments(values) {
  const role = values[0];
  const options = {};
  for (let index = 1; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || value === undefined) throw new Error("Hook 参数无效。");
    options[key.slice(2)] = value;
    index += 1;
  }
  return { role, options };
}

function hookOutput(context) {
  return context ? {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  } : {};
}

async function storedSettings(dataRoot, fsOps) {
  try {
    const content = await fsOps.readFile(path.join(dataRoot, "settings.json"), "utf8");
    const parsed = JSON.parse(String(content || "").replace(/^\uFEFF/u, ""));
    return plainObject(parsed);
  } catch {
    return {};
  }
}

function voiceCallTranscript(value) {
  const source = clean(value);
  if (!source.startsWith(VOICE_CALL_TURN_OPEN) || !source.endsWith(VOICE_CALL_TURN_CLOSE)) return "";
  const encoded = source.slice(VOICE_CALL_TURN_OPEN.length, -VOICE_CALL_TURN_CLOSE.length).trim();
  try {
    const parsed = JSON.parse(encoded);
    return parsed?.source === "suzu-live-call" ? clean(parsed.transcript).slice(0, MAX_USER_PROMPT_LENGTH) : "";
  } catch {
    return "";
  }
}

/** Returns the actual person-authored text that is suitable for recall. */
export function memoryRecallUserPrompt(value) {
  const source = clean(value);
  if (!source) return "";
  if (source.startsWith(SCHEDULE_TASK_OPEN)
    || source.startsWith(MERCHANT_TASK_OPEN)
    || source.startsWith(VOICE_CALL_OPEN_OPEN)) return "";
  if (source.startsWith(VOICE_CALL_TURN_OPEN)) return voiceCallTranscript(source);
  return source.slice(0, MAX_USER_PROMPT_LENGTH);
}

function resolvedDataRoot(configuredRoot) {
  return resolveSuzuLivesDataRoot({
    configuredRoot,
    localAppData: process.env.LOCALAPPDATA || "",
    appData: process.env.APPDATA || "",
    fallbackBase: "",
    fallbackToLocatorWhenMissing: true,
  });
}

/**
 * The actual recall lives in a UserPromptSubmit worker. Its output is attached
 * to the current user input by Claude Code, not appended to the top-level
 * system prompt used when the persistent CLI stream was spawned.
 */
export async function runMemoryRecallHook({
  args = [],
  input = "",
  safeStorage = null,
  fsOps = fs,
  now = new Date(),
  createMemoryRuntime = createLongTermMemoryService,
  createContacts = createContactProjectsService,
  createNamedConnections = createNamedApiConnectionService,
  resolveDataRoot = resolvedDataRoot,
  createTurnId = randomUUID,
} = {}) {
  let command;
  let event;
  try {
    command = hookArguments(Array.isArray(args) ? args : []);
    event = JSON.parse(String(input || ""));
  } catch {
    return {};
  }
  if (command.role !== "memory-recall") return {};

  const projectRoot = clean(command.options["project-root"]);
  const configuredDataRoot = clean(command.options["data-root"]);
  const sessionId = safeSessionId(event?.session_id);
  if (!projectRoot || !configuredDataRoot || !sessionId) return {};

  let dataRoot;
  try {
    dataRoot = clean(resolveDataRoot(configuredDataRoot));
  } catch {
    return {};
  }
  if (!dataRoot || !path.isAbsolute(dataRoot)) return {};

  const settings = await storedSettings(dataRoot, fsOps);
  const settingsService = {
    load: () => settings,
    response: () => ({ ...settings, dataRoot }),
    // createContactProjectsService requires save even though this worker only
    // reads its contact catalogue.
    save: (next) => next,
  };
  let runtime = null;
  try {
    const contacts = createContacts({ settingsService });
    const namedConnections = createNamedConnections({ dataRoot, safeStorage });
    runtime = createMemoryRuntime({
      settingsService,
      contactProjectsService: contacts,
      connectionsService: {
        resolveNamedApiConnection: (feature) => namedConnections.resolve(feature),
      },
    });
    const userText = memoryRecallUserPrompt(event?.prompt);
    if (settings.memoryRecallEnabled === false || !userText) {
      await runtime.clearUserPromptRecall?.({ projectRoot, sessionId });
      return {};
    }
    const current = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(current.getTime())) return {};
    const recalled = await runtime.recallForUserPrompt?.({
      occurredAt: current,
      projectRoot,
      sessionId,
      turnId: `hook-${clean(createTurnId())}`,
      userText,
    });
    return hookOutput(clean(recalled?.additionalContext));
  } catch {
    // Command Hooks fail open: local storage or provider failures must never
    // suppress a real user message.
    return {};
  } finally {
    try { runtime?.dispose?.(); } catch { /* No persistent worker state remains. */ }
  }
}

async function workerEnvelope(envelopePath, fsOps, temporaryRoot) {
  const selected = clean(envelopePath);
  if (!selected || !path.isAbsolute(selected)) return null;
  const inputPath = path.resolve(selected);
  const directory = path.dirname(inputPath);
  const root = path.resolve(temporaryRoot);
  if (path.basename(directory).startsWith(WORKER_DIRECTORY_PREFIX) === false) return null;
  if (path.basename(inputPath) !== WORKER_INPUT_FILE) return null;
  try {
    const [directoryStat, inputStat] = await Promise.all([fsOps.lstat(directory), fsOps.lstat(inputPath)]);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || inputStat.isSymbolicLink() || !inputStat.isFile()) return null;
    const [realTemporaryRoot, realDirectory, realInputPath] = await Promise.all([
      fsOps.realpath(root),
      fsOps.realpath(directory),
      fsOps.realpath(inputPath),
    ]);
    // Windows may spell the same user profile once as an 8.3 short path and
    // once as its long path in the parent/child processes. Compare canonical
    // paths so that distinction cannot reject our own safely owned directory.
    if (!inside(realTemporaryRoot, realDirectory)
      || !samePath(path.dirname(realInputPath), realDirectory)
      || path.basename(realInputPath) !== WORKER_INPUT_FILE) return null;
    const parsed = plainObject(JSON.parse(await fsOps.readFile(inputPath, "utf8")));
    if (!Array.isArray(parsed.args) || parsed.args.some((value) => typeof value !== "string" || value.length > 4096)) return null;
    if (typeof parsed.input !== "string" || parsed.input.length > MAX_HOOK_INPUT_LENGTH) return null;
    const outputPath = clean(parsed.outputPath);
    if (!outputPath || !path.isAbsolute(outputPath)) return null;
    const resolvedOutput = path.resolve(outputPath);
    if (!samePath(path.dirname(resolvedOutput), directory) || path.basename(resolvedOutput) !== WORKER_OUTPUT_FILE) return null;
    return { args: parsed.args, input: parsed.input, outputPath: path.join(realDirectory, WORKER_OUTPUT_FILE) };
  } catch {
    return null;
  }
}

/** Runs inside a normal Electron process so saved API credentials stay in safeStorage. */
export async function runMemoryRecallHookWorker({
  envelopePath = "",
  safeStorage = null,
  fsOps = fs,
  temporaryRoot = os.tmpdir(),
} = {}) {
  const envelope = await workerEnvelope(envelopePath, fsOps, temporaryRoot);
  if (!envelope) return {};
  const result = await runMemoryRecallHook({
    args: envelope.args,
    input: envelope.input,
    safeStorage,
    fsOps,
  });
  try {
    await fsOps.writeFile(envelope.outputPath, JSON.stringify({
      output: Object.keys(result).length ? `${JSON.stringify(result)}\n` : "",
    }), { encoding: "utf8", flag: "wx" });
  } catch {
    // The Node-side runner will simply fail open if it cannot receive a result.
  }
  return result;
}
