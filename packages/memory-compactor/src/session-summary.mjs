import { standardizeCompactedPrefix } from "./conversation.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return clean(fenced?.[1] || text);
}

function summaryBody(entries = []) {
  const record = [...entries].reverse().find((entry) => entry.record?.isCompactSummary)?.record;
  const content = typeof record?.message?.content === "string"
    ? record.message.content.trim()
    : "";
  if (!content) return "";
  for (const tag of ["conversation_summary", "first_person_memory"]) {
    const match = content.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "iu"));
    if (clean(match?.[1])) return clean(match[1]);
  }
  return content;
}

function formatMessages(messages, { limit = Number.POSITIVE_INFINITY } = {}) {
  return messages.slice(0, limit).map((message) => (
    `[${message.timestamp || ""}] ${message.role === "assistant" ? "我" : "对方"}：${message.text}`
  )).join("\n\n");
}

export const SESSION_COMPACTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "用于继续当前会话的连续第一人称摘要，不能为空。",
    },
  },
  required: ["summary"],
});

export function parseSessionCompaction(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(stripCodeFence(value));
    } catch (error) {
      throw new Error(`会话摘要模型输出不是有效 JSON：${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("会话摘要模型输出必须是 JSON 对象。");
  }
  if (Object.keys(parsed).length !== 1 || !("summary" in parsed)) {
    throw new Error("会话摘要模型输出只能包含 summary。");
  }
  const summary = clean(parsed.summary);
  if (!summary) throw new Error("会话摘要模型返回了空 summary。");
  return { summary };
}

export function buildSessionCompactionInput({
  plan,
  memoryOwner = "我",
  userName = "对方",
  boundaryContextMessages = 20,
}) {
  const messages = standardizeCompactedPrefix({
    prefix: plan.prefix,
    userName,
    memoryOwner,
  });
  const existingSummary = summaryBody(plan.prefix);
  const boundaryReference = formatMessages(
    standardizeCompactedPrefix({
      prefix: plan.preservedLogical || [],
      userName,
      memoryOwner,
    }),
    { limit: Number(boundaryContextMessages) },
  );
  const conversation = formatMessages(messages);
  const parts = [
    `对话中的“我”：${memoryOwner}`,
    `对方名字：${userName}`,
    `本次切分模式：${plan.mode}`,
  ];
  if (existingSummary) parts.push("", "【此前会话摘要】", "", existingSummary);
  if (conversation) parts.push("", "【需要压缩的早期对话】", "", conversation);
  if (boundaryReference) {
    parts.push(
      "",
      "【切点后的衔接参考，不属于压缩范围】",
      "它只能帮助判断上下文怎样衔接；不能把只在这里出现的信息提前写入摘要。",
      "",
      boundaryReference,
    );
  }
  return {
    input: `${parts.join("\n").trim()}\n`,
    messages,
  };
}
