import { defineTool } from "@suzu-lives/suzu-agent-runtime/core/tools";

import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";

export const name = "suzu-software-assistant-bridge";
export const inject = ["tools"];

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const ACTION_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const MAX_RESULT_TEXT_LENGTH = 24_000;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function timeoutMilliseconds(value) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.floor(candidate)));
}

function boundedText(value) {
  const text = String(value ?? "");
  const suffix = "…";
  return text.length > MAX_RESULT_TEXT_LENGTH
    ? `${text.slice(0, MAX_RESULT_TEXT_LENGTH - suffix.length)}${suffix}`
    : text;
}

function sessionIdFor(exec) {
  return clean(exec?.agent?.session?.id || exec?.agent?.id);
}

function requestEnvelope(exec, extra = {}) {
  return {
    sessionId: sessionIdFor(exec),
    callId: clean(exec?.callId),
    rootCallId: clean(exec?.rootCallId),
    ...extra,
  };
}

function responseContent(response, fallback) {
  if (response?.available !== true) return fallback;
  return boundedText(plainObject(response.result).content) || fallback;
}

function actionResult(value) {
  const result = plainObject(value);
  const status = clean(result.status) || (result.ok === false ? "failed" : "completed");
  const data = result.data === undefined ? null : result.data;
  const content = boundedText(result.content)
    || (status === "completed" ? "软件操作已完成。" : "软件操作未能完成。");
  return { status, content, data };
}

/**
 * Narrow bridge for the internal product-use assistant.  It is intentionally
 * separate from `suzu_capability`: this agent never receives contact-scoped
 * capabilities or a companion's lifecycle. Its fixed preset separately gives
 * it normal local inspection tools, so it can verify product files/configuration
 * when a product Skill or current status cannot answer a question.
 */
export function createSuzuSoftwareAssistantBridge({
  transport = createSuzuAgentLifecycleBridgeTransport(),
} = {}) {
  if (typeof transport?.request !== "function") {
    throw new TypeError("software assistant bridge requires request().");
  }

  const apply = (ctx, config = {}) => {
    const timeoutMs = timeoutMilliseconds(plainObject(config).timeoutMs);

    ctx.tools.register(defineTool({
      name: "suzu_software_status",
      description: "在解释或修改设置前读取当前 Suzu Lives 软件状态。它不会暴露 API Key 或其他密钥。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { content: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.content }],
      },
      async execute(_args, exec) {
        const response = await transport.request("SoftwareAssistantStatus", requestEnvelope(exec), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        return { content: responseContent(response, "当前无法读取 Suzu Lives 的软件状态。") };
      },
      presentCall: () => ({ card: "generic", title: "查看软件状态", kind: "read", rawInput: "" }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_software_action",
      description: "执行一项已登记的 Suzu Lives 软件动作。需要确认当前页面入口或动作输入时，先读取 suzu_software_status 并加载相关产品 Skill。只有此工具返回 completed 时，才能声称动作已成功。",
      parameters: {
        action: {
          type: "string",
          required: true,
          description: "准确的已登记动作 ID：navigate、set-theme、create-contact、lookup-contact-avatar 或 set-contact-avatar。",
        },
        input: {
          type: "json",
          description: "动作所需的 JSON 输入。navigate 使用 { destinationId }，set-theme 使用 { theme: \"light\" | \"dark\" }，create-contact 使用 { name, personaContent? }，lookup-contact-avatar 使用 { query } 或已确认候选的 { title } 并从萌娘百科保存头像预览，set-contact-avatar 使用 { contactId? 或 contactName?, avatarPath }。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            content: { type: "string", required: true },
            data: { type: "json", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.content }],
      },
      async execute(args, exec) {
        const action = clean(args?.action);
        if (!ACTION_ID.test(action)) {
          return {
            status: "invalid-request",
            content: "软件动作 ID 无效；请先读取当前软件状态并确认已登记动作。",
            data: null,
          };
        }
        const response = await transport.request("SoftwareAssistantAction", requestEnvelope(exec, {
          action,
          ...(args?.input === undefined ? {} : { input: args.input }),
        }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return {
            status: "parent-unavailable",
            content: "Suzu Lives 软件操作桥当前不可用。",
            data: null,
          };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({
        card: "generic",
        title: clean(args?.action) === "lookup-contact-avatar"
          ? "从萌娘百科查找头像"
          : `Suzu Lives：${clean(args?.action) || "软件操作"}`,
        kind: "other",
        rawInput: args?.input === undefined ? "" : args.input,
      }),
    }));
  };

  return Object.freeze({ apply });
}

const defaultSoftwareAssistantBridge = createSuzuSoftwareAssistantBridge();

export function apply(ctx, config = {}) {
  return defaultSoftwareAssistantBridge.apply(ctx, config);
}
