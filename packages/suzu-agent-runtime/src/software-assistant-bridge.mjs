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
  return text.length > MAX_RESULT_TEXT_LENGTH ? `${text.slice(0, MAX_RESULT_TEXT_LENGTH)}\n[内容已截断]` : text;
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
 * when the user-facing manual cannot answer a question.
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
      description: "Read the current Suzu Lives software state before explaining or changing a setting. It never exposes API keys or other secrets.",
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
      name: "suzu_software_manual",
      description: "Read Suzu Lives' current product manual for a user goal or feature. Use it instead of guessing page names, configuration steps, or supported software actions.",
      parameters: {
        query: {
          type: "string",
          description: "A concise user goal or feature name. Omit only to list the product operation index.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { content: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.content }],
      },
      async execute(args, exec) {
        const response = await transport.request("SoftwareAssistantManual", requestEnvelope(exec, {
          query: clean(args?.query),
        }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        return { content: responseContent(response, "当前无法读取 Suzu Lives 的软件说明。") };
      },
      presentCall: (args) => ({
        card: "generic",
        title: "查找软件说明",
        kind: "read",
        rawInput: clean(args?.query),
      }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_software_action",
      description: "Run one documented Suzu Lives software action. Read suzu_software_manual first when the needed action or its input is not already known. Never claim an action succeeded without this tool returning completed.",
      parameters: {
        action: {
          type: "string",
          required: true,
          description: "Exact documented action ID, such as navigate or set-theme.",
        },
        input: {
          type: "json",
          description: "Documented action input. For example, navigate uses { destinationId }, and set-theme uses { theme: \"light\" | \"dark\" }.",
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
            content: "软件动作 ID 无效；请先读取 suzu_software_manual。",
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
        title: `Suzu Lives：${clean(args?.action) || "软件操作"}`,
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
