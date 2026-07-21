#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveMemories } from "./retrieve.mjs";

const HISTORICAL_TIME_MARKERS = /(?:上次|以前|之前|过去|当时|那时|那天|昨天|前天|记得|回忆|曾经)/u;

export function isCurrentTimeQuery(value) {
  const original = String(value || "").trim();
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

export function ragSkipReason(prompt) {
  const value = String(prompt || "").trim();
  if (!value) return "empty-prompt";
  if (value.includes("根据时间和前面聊的内容") || value.startsWith("临时回访：")) {
    return "timer-context";
  }
  if (isCurrentTimeQuery(value)) return "current-time-query";
  return "";
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  const event = JSON.parse(raw);
  if (event.hook_event_name !== "UserPromptSubmit") return;
  const prompt = String(event.prompt || "").trim();
  if (!prompt) return;

  // Timer 已经带有当前会话或具体回访情境，不需要再检索历史记忆。
  if (ragSkipReason(prompt)) return;

  const result = await retrieveMemories(prompt);
  if (!result.context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: result.context,
    },
  }));
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // RAG 只能补充记忆，绝不能因为自身故障阻断正常聊天。
    console.error(`RAG hook 已跳过：${error.message}`);
    process.exitCode = 0;
  });
}
