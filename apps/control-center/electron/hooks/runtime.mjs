import fs from "node:fs";
import path from "node:path";

import { resolveAgentDataRoot, stableAgentId } from "@suzu-lives/agent-registry";

import { createMemoryService } from "../services/memory-service.mjs";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const PUBLIC_DATES = new Map([["01-01", "元旦"], ["05-01", "劳动节"], ["10-01", "国庆节"]]);
const MAX_PROMPT_LENGTH = 12_000;
const HISTORICAL_TIME_MARKERS = /(?:上次|以前|之前|过去|当时|那时|那天|昨天|前天|记得|回忆|曾经)/u;

function clean(value) { return String(value ?? "").trim(); }
function pad(value) { return String(value).padStart(2, "0"); }
function privateCalendarPath(dataRoot, agentId) { return path.join(resolveAgentDataRoot({ dataRoot, agentId }), "time-awareness", "calendar.local.json"); }

export function isMemoryRecallEnabled({ dataRoot, readFile = fs.readFileSync } = {}) {
  const root = clean(dataRoot);
  if (!root) return true;
  try {
    const settings = JSON.parse(String(readFile(path.join(root, "settings.json"), "utf8") || "").replace(/^\uFEFF/u, ""));
    return settings?.memoryRecallEnabled !== false;
  } catch {
    return true;
  }
}

function readPrivateEvents(filePath, now) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")); } catch { return []; }
  if (!Array.isArray(parsed?.events)) return [];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const recurring = date.slice(5);
  return parsed.events
    .filter((event) => event && typeof event === "object" && event.enabled !== false)
    .filter((event) => clean(event.date) === date || clean(event.date) === recurring)
    .map((event) => clean(event.name).slice(0, 120))
    .filter(Boolean);
}

export function isCurrentTimeQuery(value) {
  const original = clean(value);
  if (!original || original.length > 50 || HISTORICAL_TIME_MARKERS.test(original)) return false;
  const text = original
    .replace(/[\s，。！？、,.!?：:；;“”"'（）()【】\[\]]+/gu, "")
    .replace(/^(?:请问|问一下|告诉我|你知道|你看一下|帮我看一下)/u, "")
    .replace(/(?:呢|呀|啊|嘛|吧)$/u, "");
  return [
    /^(?:现在|当前|此刻|这会儿|这时候)?(?:是)?几点(?:了|钟)?$/u,
    /^(?:现在|当前|此刻|今天|今日)?(?:是)?(?:几月几日|几月几号|几号)(?:的)?几点(?:几分|了|钟)?$/u,
    /^(?:现在|当前|此刻)?(?:的)?时间(?:是)?(?:多少|几点)?$/u,
    /^(?:今天|今日)(?:是)?(?:几月几日|几月几号|几号|什么日期|哪一天|星期几|周几)$/u,
    /^(?:现在|当前|此刻)?(?:是)?(?:早上|上午|中午|下午|晚上|深夜|凌晨)(?:吗|了)?$/u,
    /^(?:现在|当前|此刻)?天(?:亮|黑)了(?:吗)?$/u,
  ].some((pattern) => pattern.test(text));
}

export function memorySkipReason(prompt) {
  const value = clean(prompt);
  if (!value) return "empty-prompt";
  if (value.includes("根据时间和前面聊的内容") || value.startsWith("临时回访：")) return "timer-context";
  return isCurrentTimeQuery(value) ? "current-time-query" : "";
}

export function timeAwarenessContext({ now = new Date(), calendarPath = "" } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error("当前时间无效。");
  const dateKey = `${pad(current.getMonth() + 1)}-${pad(current.getDate())}`;
  const names = [...new Set([PUBLIC_DATES.get(dateKey), ...readPrivateEvents(calendarPath, current)].filter(Boolean))];
  const base = `你知道现在是${current.getMonth() + 1}月${current.getDate()}日 ${WEEKDAYS[current.getDay()]} ${pad(current.getHours())}:${pad(current.getMinutes())}。`;
  if (!names.length) return base;
  return `${base}今天是${names.map((name, index) => index ? `也是${name}` : name).join("，")}。`;
}

function hookSettings({ projectRoot, dataRoot }) {
  const agentId = stableAgentId(projectRoot);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  return {
    projectRoot,
    agentId,
    dataRoot,
    usageLedgerPath: path.join(agentRoot, "cost-ledger", "events.jsonl"),
  };
}

export async function userPromptContext({
  projectRoot,
  dataRoot,
  prompt,
  sessionId = "",
  now = new Date(),
  search = null,
  connectionResolver = null,
} = {}) {
  const root = clean(projectRoot); const softwareDataRoot = clean(dataRoot); const query = clean(prompt).slice(0, MAX_PROMPT_LENGTH);
  if (!root || !softwareDataRoot) return "";
  const settings = hookSettings({ projectRoot: root, dataRoot: softwareDataRoot });
  const recallEnabled = isMemoryRecallEnabled({ dataRoot: softwareDataRoot });
  const memoryService = !recallEnabled || search ? null : createMemoryService({
    settingsService: { load: () => settings, response: () => settings },
    connectionResolver,
  });
  const contexts = [timeAwarenessContext({ now, calendarPath: privateCalendarPath(softwareDataRoot, settings.agentId) })];
  if (!recallEnabled) return contexts.join("\n\n");
  if (!query || memorySkipReason(query)) {
    try { memoryService?.clearRetrievalSessionHead(sessionId); } catch { /* fail open */ }
    return contexts.join("\n\n");
  }
  try {
    const searchOptions = {
      persistTrace: true,
      runtimeSource: "claude-user-prompt-hook",
      runtimeSessionId: clean(sessionId),
      now,
    };
    const result = search
      ? await search(query, searchOptions)
      : await memoryService.search(query, searchOptions);
    if (clean(result?.context)) contexts.push(result.context);
  } catch {
    // Hooks are fail-open: unavailable storage or retrieval never blocks Claude.
  }
  return contexts.join("\n\n");
}

export async function captureRetrievalUsage({
  projectRoot,
  dataRoot,
  sessionId,
  responseText,
  bind = null,
} = {}) {
  const root = clean(projectRoot);
  const softwareDataRoot = clean(dataRoot);
  const session = clean(sessionId);
  const response = clean(responseText);
  if (!root || !softwareDataRoot || !session || !response) return null;
  if (typeof bind === "function") return bind({ runtimeSessionId: session, responseText: response });
  const settings = hookSettings({ projectRoot: root, dataRoot: softwareDataRoot });
  return createMemoryService({
    settingsService: { load: () => settings, response: () => settings },
  }).bindRetrievalUsageResponse({
    runtimeSessionId: session,
    responseText: response,
  });
}

export function userPromptHookOutput(context) {
  return context ? {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  } : {};
}

function parsedArguments(values) {
  const role = values[0]; const options = {};
  for (let index = 1; index < values.length; index += 1) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Hook 参数无效。");
    options[key.slice(2)] = value; index += 1;
  }
  return { role, options };
}

export async function runProjectHook({ args = [], input = "", now = new Date(), search = null, bindRetrievalUsage = null, connectionResolver = null } = {}) {
  let parsed;
  try { parsed = JSON.parse(String(input || "")); } catch { return {}; }
  let command;
  try { command = parsedArguments(args); } catch { return {}; }
  if (command.role === "time-awareness") {
    const root = clean(command.options["project-root"]);
    const softwareDataRoot = clean(command.options["data-root"]);
    if (!root || !softwareDataRoot) return {};
    try {
      const agentId = stableAgentId(root);
      return userPromptHookOutput(timeAwarenessContext({
        now,
        calendarPath: privateCalendarPath(softwareDataRoot, agentId),
      }));
    } catch {
      return {};
    }
  }
  if (command.role === "assistant-stop") {
    try {
      await captureRetrievalUsage({
        projectRoot: command.options["project-root"],
        dataRoot: command.options["data-root"],
        sessionId: parsed?.session_id,
        responseText: parsed?.last_assistant_message,
        bind: bindRetrievalUsage,
      });
    } catch {
      // Stop usage capture is side-effect only and must never alter Claude's reply.
    }
    return {};
  }
  if (command.role !== "user-prompt") return {};
  try {
    const context = await userPromptContext({
      projectRoot: command.options["project-root"],
      dataRoot: command.options["data-root"],
      prompt: parsed?.prompt,
      sessionId: parsed?.session_id,
      now,
      search,
      connectionResolver,
    });
    return userPromptHookOutput(context);
  } catch {
    return {};
  }
}

export async function runProjectHookCli({ args = process.argv.slice(3), stdin = process.stdin, stdout = process.stdout, connectionResolver = null } = {}) {
  let input = "";
  try {
    for await (const chunk of stdin) input += chunk;
    const result = await runProjectHook({ args, input, connectionResolver });
    if (result.forwardedOutput) stdout.write(result.forwardedOutput);
    else if (Object.keys(result).length) stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Command hooks must fail open and keep stdout clean on every error path.
  }
}
