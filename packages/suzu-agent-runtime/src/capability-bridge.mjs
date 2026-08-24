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
  const suffix = "…";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}` : text;
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

function bridgeFailure(response) {
  const reason = clean(plainObject(response).reason);
  let failure;
  switch (reason) {
    case "timeout":
      failure = {
        code: "CAPABILITY_BRIDGE_TIMEOUT",
        status: "parent-timeout",
        content: "Suzu 产品能力桥等待桌面主进程响应超时；该能力没有返回执行结果。",
      };
      break;
    case "unavailable":
      failure = {
        code: "CAPABILITY_BRIDGE_DISCONNECTED",
        status: "parent-unavailable",
        content: "Suzu 产品能力桥未连接到桌面主进程，无法执行该能力。",
      };
      break;
    case "disposed":
      failure = {
        code: "CAPABILITY_BRIDGE_DISPOSED",
        status: "parent-disposed",
        content: "Suzu Agent Core 正在退出，产品能力请求已取消。",
      };
      break;
    default:
      failure = {
        code: "CAPABILITY_BRIDGE_NO_RESPONSE",
        status: "parent-unavailable",
        content: "Suzu 产品能力桥未收到桌面主进程的执行结果。",
      };
  }
  return {
    status: failure.status,
    content: failure.content,
    data: {
      code: failure.code,
      ...(reason ? { reason } : {}),
    },
  };
}

function bridgeTransportFailure(error) {
  const message = clean(error?.message || error) || "能力桥通信发生未知错误。";
  return {
    status: "parent-transport-error",
    content: `Suzu 产品能力桥通信失败：${message}`,
    data: {
      code: clean(error?.code) || "CAPABILITY_BRIDGE_TRANSPORT_FAILED",
      message,
    },
  };
}

function capabilityResult(value) {
  const result = plainObject(value);
  const status = clean(result.status) || (result.ok === false ? "failed" : "completed");
  const payload = result.value === undefined
    ? result.error === undefined ? result : result.error
    : result.value;
  const errorMessage = clean(plainObject(result.error).message);
  const content = status === "completed"
    ? renderedValue(payload) || "能力动作已完成。"
    : errorMessage || renderedValue(payload) || `能力动作未完成：${status}`;
  return {
    status,
    content,
    data: payload === undefined ? null : payload,
  };
}

/**
 * One Agent Core-native execution tool for all product-owned actions.
 *
 * The plugin owns no CLI credentials, MCP connection, or product storage.
 * Product Skills provide the detailed capability/action contract only when
 * the model calls Core's native `skill` tool. This bridge delegates the
 * selected action back to the Electron parent, which validates it again.
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
      name: "suzu_capability",
      description: "执行已加载的 Suzu 产品 Skill 声明的能力动作。日常终端工作使用直接 PowerShell/Bash；此工具仅用于需要产品适配器的已连接 Suzu 能力。",
      parameters: {
        capabilityId: {
          type: "string",
          required: true,
          description: "已加载 Suzu 产品 Skill 声明的准确 capabilityId。",
        },
        action: {
          type: "string",
          required: true,
          description: "已加载 Suzu 产品 Skill 声明的准确动作名称。",
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
            content: "能力 ID 或动作 ID 无效；请先加载对应的 Suzu 产品 Skill。",
            data: null,
          };
        }
        let response;
        try {
          response = await transport.request("CapabilityExecute", {
            sessionId: sessionIdFor(exec),
            callId: clean(exec?.callId),
            rootCallId: clean(exec?.rootCallId),
            capabilityId,
            action,
            ...(args.input === undefined ? {} : { input: args.input }),
          }, { timeoutMs });
        } catch (error) {
          return bridgeTransportFailure(error);
        }
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) return bridgeFailure(response);
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
