import { defineTool } from "@suzu-lives/suzu-agent-runtime/core/tools";

import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";

export const name = "suzu-capability-bridge";
export const inject = ["tools"];

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_RESULT_TEXT_LENGTH = 16_000;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,127}$/u;

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

function boundedText(value, limit = MAX_RESULT_TEXT_LENGTH) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text;
}

function renderedValue(value) {
  if (typeof value === "string") return boundedText(value);
  if (value === undefined) return "";
  try { return boundedText(JSON.stringify(value, null, 2)); }
  catch { return "[产品能力返回了无法展示的数据]"; }
}

function sessionIdFor(exec) {
  return clean(exec?.agent?.session?.id || exec?.agent?.id);
}

function catalogActions(value) {
  const actions = Array.isArray(plainObject(value).actions) ? plainObject(value).actions : [];
  return actions.flatMap((entry) => {
    const source = plainObject(entry);
    const capabilityId = clean(source.capabilityId);
    const action = clean(source.action);
    const description = clean(source.actionDescription || source.description);
    if (!IDENTIFIER.test(capabilityId) || !IDENTIFIER.test(action) || !description) return [];
    return [Object.freeze({
      capabilityId,
      action,
      description,
      ...(clean(source.capabilityName) ? { capabilityName: clean(source.capabilityName) } : {}),
      ...(clean(source.actionName) ? { actionName: clean(source.actionName) } : {}),
    })];
  });
}

function catalogText(actions) {
  if (!actions.length) return "目前没有已接入的 Suzu 产品能力动作。";
  return actions.map((entry) => [
    `${entry.capabilityId}.${entry.action}`,
    entry.capabilityName ? `（${entry.capabilityName}）` : "",
    `：${entry.description}`,
  ].join("")).join("\n");
}

function capabilityResult(value) {
  const result = plainObject(value);
  const status = clean(result.status) || (result.ok === false ? "failed" : "completed");
  const payload = result.value === undefined
    ? result.error === undefined ? result : result.error
    : result.value;
  const content = status === "completed"
    ? renderedValue(payload) || "能力动作已完成。"
    : renderedValue(payload) || `能力动作未完成：${status}`;
  return {
    status,
    content,
    data: payload === undefined ? null : payload,
  };
}

/**
 * One Agent Core-native pair of tools for all product-owned actions.
 *
 * The plugin owns no CLI credentials, MCP connection, or product storage.
 * It asks the Electron parent for the currently connected action catalog, then
 * delegates one explicitly declared action back to the same parent.  New
 * capabilities only need a registry action declaration plus their adapter;
 * the static Agent Core preset never needs one tool per capability.
 */
export function createSuzuCapabilityBridge({
  transport = createSuzuAgentLifecycleBridgeTransport(),
} = {}) {
  if (typeof transport?.request !== "function") {
    throw new TypeError("capability bridge requires request().");
  }

  const apply = (ctx, config = {}) => {
    const timeoutMs = timeoutMilliseconds(plainObject(config).timeoutMs);
    ctx.tools.register(defineTool({
      name: "suzu_capability_catalog",
      description: "列出当前为此对话已连接的 Suzu 产品能力动作。调用 suzu_capability 前先读取此目录；不要猜测能力或动作名称。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            actions: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  capabilityId: { type: "string", required: true },
                  action: { type: "string", required: true },
                  description: { type: "string", required: true },
                  capabilityName: { type: "string" },
                  actionName: { type: "string" },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: catalogText(value.actions) }],
      },
      async execute(_args, exec) {
        const response = await transport.request("CapabilityCatalog", {
          sessionId: sessionIdFor(exec),
          callId: clean(exec?.callId),
          rootCallId: clean(exec?.rootCallId),
        }, { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        return { actions: response.available ? catalogActions(response.result) : [] };
      },
      presentCall: () => ({
        card: "generic",
        title: "查看 Suzu 能力",
        kind: "read",
        rawInput: "",
      }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_capability",
      description: "执行一个由 suzu_capability_catalog 返回的 Suzu 产品能力动作。日常终端工作使用直接 PowerShell/Bash；此工具仅用于需要产品适配器的已连接 Suzu 能力。",
      parameters: {
        capabilityId: {
          type: "string",
          required: true,
          description: "suzu_capability_catalog 返回的准确 capabilityId。",
        },
        action: {
          type: "string",
          required: true,
          description: "suzu_capability_catalog 返回的准确动作名称。",
        },
        input: {
          type: "json",
          description: "该目录项要求的动作输入；动作不需要输入时省略。",
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
        const capabilityId = clean(args.capabilityId);
        const action = clean(args.action);
        if (!IDENTIFIER.test(capabilityId) || !IDENTIFIER.test(action)) {
          return {
            status: "invalid-request",
            content: "能力 ID 或动作 ID 无效；请先读取 suzu_capability_catalog。",
            data: null,
          };
        }
        const response = await transport.request("CapabilityExecute", {
          sessionId: sessionIdFor(exec),
          callId: clean(exec?.callId),
          rootCallId: clean(exec?.rootCallId),
          capabilityId,
          action,
          ...(args.input === undefined ? {} : { input: args.input }),
        }, { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (!response.available) {
          return {
            status: "parent-unavailable",
            content: "Suzu 产品能力桥当前不可用。",
            data: null,
          };
        }
        return capabilityResult(response.result);
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Suzu 能力：${clean(args.capabilityId) || "未知"}.${clean(args.action) || "未知"}`,
        kind: "other",
        rawInput: args.input === undefined ? "" : args.input,
      }),
    }));
  };

  return Object.freeze({ apply });
}

const defaultCapabilityBridge = createSuzuCapabilityBridge();

export function apply(ctx, config = {}) {
  return defaultCapabilityBridge.apply(ctx, config);
}
