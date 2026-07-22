import fs from "node:fs";
import path from "node:path";

import { loadRagConfig } from "./retrieve.mjs";

const AUTOMATION_PROMPT_PREFIXES = [
  "链式关心。当前时间",
  "每日回顾。",
  "根据时间和前面聊的内容判断",
  "Base directory for this skill:",
];

function contentBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content : [];
}

export function cleanText(value) {
  return String(value || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, "")
    .replace(/<local-command-(?:caveat|stdout)>[\s\S]*?<\/local-command-(?:caveat|stdout)>/giu, "")
    .replace(/\n*Context:\s*```(?:json)?[\s\S]*?```\s*/giu, "\n")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:课|course|count|test|发自我的\s*iPhone)\s*$/iu.test(line))
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isOperationalText(value) {
  const text = String(value || "").trim();
  return !text
    || text === "NO_REPLY"
    || /^API Error:\s*\d+/iu.test(text)
    || /^\d{3}\s+(?:Insufficient Balance|Unauthorized|Forbidden|Too Many Requests)\b/iu.test(text)
    || /^<task-notification>[\s\S]*<\/task-notification>$/iu.test(text)
    || text.includes("<command-name>")
    || /^<system-reminder>[\s\S]*<\/system-reminder>$/iu.test(text)
    || /^<local-command-(?:caveat|stdout)>/iu.test(text);
}

export function isAutomationPrompt(value) {
  const text = String(value || "").trim();
  return AUTOMATION_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function visibleUserText(entry) {
  const record = entry?.record || {};
  if (
    record.type !== "user"
    || record.message?.role !== "user"
    || record.isCompactSummary
    || record.isMeta
  ) return "";

  const blocks = contentBlocks(record.message.content);
  if (blocks.some((block) => block?.type === "tool_result")) return "";
  const text = cleanText(blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n"));
  return isOperationalText(text) ? "" : text;
}

export function visibleAssistantTexts(entry) {
  const record = entry?.record || {};
  if (
    record.type !== "assistant"
    || record.message?.role !== "assistant"
    || record.isCompactSummary
    || record.isMeta
  ) return [];

  return contentBlocks(record.message.content)
    .filter((block) => block?.type === "text")
    .map((block) => cleanText(block.text))
    .filter((text) => !isOperationalText(text));
}

function makeMessage(entry, role, speaker, text, sourceKind, ordinal) {
  const sourceUuid = entry.record.uuid;
  if (!sourceUuid) return null;
  return {
    id: `${sourceUuid}:${sourceKind}:${ordinal}`,
    source_uuid: sourceUuid,
    source_index: entry.index,
    timestamp: entry.record.timestamp || null,
    role,
    speaker,
    text,
    source_kind: sourceKind,
  };
}

/**
 * Convert the raw records that are leaving short-term context into the only
 * messages RAG is allowed to remember: visible user and assistant text.
 * Thinking, tools, tool results, compact records and automation turns never
 * become retrieval material.
 */
export function standardizeCompactedPrefix({
  prefix,
  userName = "对方",
  memoryOwner = "我",
}) {
  const messages = [];
  let skipAutomationTurn = false;

  for (const entry of prefix || []) {
    const userText = visibleUserText(entry);
    if (userText) {
      skipAutomationTurn = isAutomationPrompt(userText);
      if (!skipAutomationTurn) {
        const item = makeMessage(entry, "user", userName, userText, "user_text", 0);
        if (item) messages.push(item);
      }
      continue;
    }

    if (skipAutomationTurn) continue;
    const assistantTexts = visibleAssistantTexts(entry);
    assistantTexts.forEach((text, ordinal) => {
      const item = makeMessage(entry, "assistant", memoryOwner, text, "assistant_text", ordinal);
      if (item) messages.push(item);
    });
  }
  return messages;
}

function readKnownIds(historyPath) {
  const ids = new Set();
  const originalText = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, "utf8") : "";
  const lines = originalText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`历史库第 ${index + 1} 行损坏，已停止追加：${error.message}`);
    }
    if (item?.id) ids.add(item.id);
  }
  return { ids, originalText };
}

/**
 * Validate and stage a history append before the main transcript is changed.
 * commit() refuses to write if another process changed history in between.
 */
export function prepareHistoryAppend(messages, configOverride = "") {
  const config = loadRagConfig(configOverride);
  const { ids, originalText } = readKnownIds(config.historyPath);
  const accepted = [];
  for (const message of messages || []) {
    if (!message?.id || ids.has(message.id)) continue;
    ids.add(message.id);
    accepted.push(message);
  }

  const result = {
    historyPath: config.historyPath,
    added: accepted.length,
    totalKnown: ids.size,
  };
  return {
    ...result,
    commit() {
      if (!accepted.length) return result;
      const currentText = fs.existsSync(config.historyPath)
        ? fs.readFileSync(config.historyPath, "utf8")
        : "";
      if (currentText !== originalText) {
        throw new Error("RAG 历史库在本次处理期间发生变化，已拒绝覆盖");
      }
      fs.mkdirSync(path.dirname(config.historyPath), { recursive: true });
      const separator = originalText && !/\r?\n$/.test(originalText) ? "\n" : "";
      const payload = `${separator}${accepted.map((item) => JSON.stringify(item)).join("\n")}\n`;
      fs.appendFileSync(config.historyPath, payload, "utf8");
      return result;
    },
  };
}
