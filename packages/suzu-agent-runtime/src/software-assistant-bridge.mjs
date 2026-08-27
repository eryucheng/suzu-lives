import { defineTool } from "@suzu-lives/suzu-agent-runtime/core/tools";

import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";
import { SUZU_AGENT_PERMISSION_MODES } from "./permission-modes.mjs";
import { SUZU_AGENT_REASONING_EFFORTS } from "./reasoning-efforts.mjs";

export const name = "suzu-software-assistant-bridge";
export const inject = ["tools"];

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const SOFTWARE_ACTION_IDS = Object.freeze([
  "navigate",
  "set-theme",
  "create-contact",
  "lookup-character-profile",
  "lookup-contact-avatar",
  "set-contact-avatar",
]);
const MAIN_MODEL_PROVIDER_IDS = Object.freeze([
  "deepseek",
  "minimax",
  "bailian-coding",
  "bailian-payg",
  "kimi",
  "kimi-api",
  "moonshot",
  "tongyi",
  "dashscope",
  "bailian",
  "openai",
  "zhipu",
  "ollama",
  "custom",
]);
const MAIN_MODEL_PROTOCOL_IDS = Object.freeze([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
const API_CONNECTION_PROVIDER_IDS = Object.freeze([
  "openai",
  "deepseek",
  "moonshot",
  "zhipu",
  "tongyi",
  "ollama",
  "dashscope",
  "custom-openai",
  "tts-api",
  "asr-api",
  "generic-api",
]);
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

function renderActionResult(_args, value) {
  const result = actionResult(value);
  const dataText = result.data === null ? "" : JSON.stringify(result.data, null, 2);
  return [{
    type: "text",
    text: boundedText([
      `状态：${result.status}`,
      result.content,
      dataText ? `结果数据：\n${dataText}` : "",
    ].filter(Boolean).join("\n\n")),
  }];
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
      description: "读取当前 Suzu Lives 的主题、版本、更新状态、数据目录和程序位置。",
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
      name: "suzu_software_page_search",
      description: "按名称或用途查找 Suzu Lives 已登记的页面，返回页面 ID 和界面路径。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "要查找的页面名称、功能或设置。",
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
        const query = clean(args?.query);
        if (!query) {
          return {
            status: "invalid-request",
            content: "请提供要查找的页面、功能或设置。",
            data: { results: [] },
          };
        }
        const response = await transport.request("SoftwareAssistantPageSearch", requestEnvelope(exec, { query }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return {
            status: "parent-unavailable",
            content: "Suzu Lives 页面查询当前不可用。",
            data: { results: [] },
          };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({ card: "generic", title: "查找软件页面", kind: "read", rawInput: clean(args?.query) }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_main_model_status",
      description: "读取 Suzu Lives 当前主模型的厂商、模型与连接状态。",
      parameters: {},
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
      async execute(_args, exec) {
        const response = await transport.request("SoftwareAssistantMainModelStatus", requestEnvelope(exec), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return { status: "parent-unavailable", content: "Suzu Lives 主模型读取当前不可用。", data: null };
        }
        return actionResult(response.result);
      },
      presentCall: () => ({ card: "generic", title: "查看主模型", kind: "read", rawInput: "" }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_main_model_save",
      description: "保存 Suzu Lives 的主模型连接；内置厂商会使用产品登记的地址、协议和默认模型。",
      parameters: {
        provider: {
          type: "string",
          required: true,
          enum: MAIN_MODEL_PROVIDER_IDS,
          description: "主模型厂商 ID。",
        },
        apiKey: { type: "string", description: "用户提供的 API Key；更新其他字段且保留现有密钥时可省略。" },
        model: { type: "string", description: "模型标识；内置厂商省略时使用产品默认值。" },
        baseUrl: { type: "string", description: "服务地址；自定义服务需要提供。" },
        protocol: { type: "string", enum: MAIN_MODEL_PROTOCOL_IDS, description: "自定义服务协议。" },
        providerLabel: { type: "string", description: "自定义服务的显示名称。" },
        route: { type: "string", description: "自定义服务的稳定路由 ID。" },
        supportsImageInput: { type: "boolean", description: "自定义模型是否支持图片输入。" },
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
        const response = await transport.request("SoftwareAssistantMainModelSave", requestEnvelope(exec, { input: args }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return { status: "parent-unavailable", content: "Suzu Lives 主模型保存当前不可用。", data: null };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({
        card: "generic",
        title: "保存主模型",
        kind: "other",
        rawInput: [clean(args?.provider), clean(args?.model)].filter(Boolean).join(" · "),
      }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_api_connection_search",
      description: "查找已保存的 API 连接，返回连接 ID、备注、类型、地址、默认模型和密钥状态。",
      parameters: {
        query: { type: "string", description: "备注、厂商、服务地址、模型或连接 ID；留空时列出全部。" },
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
        const response = await transport.request("SoftwareAssistantApiConnectionSearch", requestEnvelope(exec, {
          query: clean(args?.query),
        }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return { status: "parent-unavailable", content: "Suzu Lives API 连接查询当前不可用。", data: { connections: [] } };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({ card: "generic", title: "查找 API 连接", kind: "read", rawInput: clean(args?.query) }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_api_connection_save",
      description: "新建或更新一条 Suzu Lives API 连接；已登记厂商会自动补服务类型和官方地址。",
      parameters: {
        provider: {
          type: "string",
          required: true,
          enum: API_CONNECTION_PROVIDER_IDS,
          description: "API 厂商或服务类型 ID。",
        },
        connectionId: { type: "string", description: "要更新的连接 ID；新建时省略。" },
        name: { type: "string", description: "连接备注；省略时使用厂商名称。" },
        apiKey: { type: "string", description: "用户提供的 API Key；更新其他字段且保留现有密钥时可省略。" },
        baseUrl: { type: "string", description: "自定义服务地址，或覆盖厂商预设地址。" },
        model: { type: "string", description: "默认模型标识。" },
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
        const response = await transport.request("SoftwareAssistantApiConnectionSave", requestEnvelope(exec, { input: args }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return { status: "parent-unavailable", content: "Suzu Lives API 连接保存当前不可用。", data: null };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({
        card: "generic",
        title: "保存 API 连接",
        kind: "other",
        rawInput: [clean(args?.name) || clean(args?.provider), clean(args?.model)].filter(Boolean).join(" · "),
      }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_contact_search",
      description: "按名称或联系人 ID 查找 Suzu Lives 中可见的联系人，并返回稳定 ID、联系人工作区和可填写资料的位置。查询留空时列出可见联系人。",
      parameters: {
        query: {
          type: "string",
          description: "联系人名称或联系人 ID；留空时列出可见联系人。",
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
        const response = await transport.request("SoftwareAssistantContactSearch", requestEnvelope(exec, {
          query: clean(args?.query),
        }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return {
            status: "parent-unavailable",
            content: "Suzu Lives 联系人查询当前不可用。",
            data: { contacts: [] },
          };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({ card: "generic", title: "查找联系人", kind: "read", rawInput: clean(args?.query) }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_contact_read",
      description: "读取一位现有联系人的资料与稳定位置。可读取联系人概况、相处设定、角色人设或用户资料。",
      parameters: {
        contactId: {
          type: "string",
          description: "联系人稳定 ID；已知时优先使用。",
        },
        contactName: {
          type: "string",
          description: "联系人名称；名称重复时工具会返回候选联系人 ID。",
        },
        section: {
          type: "string",
          enum: ["all", "relationship", "persona", "user"],
          description: "要读取的资料：all 为全部标准资料，relationship 为相处设定，persona 为角色人设，user 为用户资料。默认 all。",
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
        const response = await transport.request("SoftwareAssistantContactRead", requestEnvelope(exec, {
          input: args,
        }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return {
            status: "parent-unavailable",
            content: "Suzu Lives 联系人资料读取当前不可用。",
            data: null,
          };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({
        card: "generic",
        title: "读取联系人资料",
        kind: "read",
        rawInput: clean(args?.contactId) || clean(args?.contactName),
      }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_contact_update",
      description: "更新一位现有联系人的备注、相处资料和常用联系人设置。可直接按唯一联系人名称更新；名称重复时会返回候选联系人 ID。",
      parameters: {
        contactId: {
          type: "string",
          description: "联系人稳定 ID；已知时优先使用。",
        },
        contactName: {
          type: "string",
          description: "要更新的联系人名称；名称重复时工具会返回候选联系人 ID。",
        },
        newName: {
          type: "string",
          description: "新的联系人备注名称。",
        },
        relationshipContent: {
          type: "string",
          description: "写入 SUZU.md 的联系人视角设定；“你”指联系人 Agent，“用户”指软件用户，内容包括双方关系、称呼、日常相处方式与当前情境。",
        },
        personaContent: {
          type: "string",
          description: "写入 persona.md 的角色身份、核心动机、反应方式、语言风格与对话示例。",
        },
        userContent: {
          type: "string",
          description: "写入 user.md 的用户资料、偏好与希望被如何对待的信息。",
        },
        pinned: {
          type: "boolean",
          description: "是否在联系人列表置顶。",
        },
        muted: {
          type: "boolean",
          description: "是否开启消息免打扰。",
        },
        longTermMemoryEnabled: {
          type: "boolean",
          description: "是否启用这位联系人的长期记忆。",
        },
        permissionMode: {
          type: "string",
          enum: SUZU_AGENT_PERMISSION_MODES,
          description: "联系人审批模式：danger-full-access、workspace-write 或 read-only。",
        },
        reasoningEffort: {
          type: "string",
          enum: SUZU_AGENT_REASONING_EFFORTS,
          description: "联系人思考强度：off、low、high 或 max。",
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
        const response = await transport.request("SoftwareAssistantContactUpdate", requestEnvelope(exec, {
          input: args,
        }), { timeoutMs });
        exec?.signal?.throwIfAborted?.();
        if (response?.available !== true) {
          return {
            status: "parent-unavailable",
            content: "Suzu Lives 联系人资料更新当前不可用。",
            data: null,
          };
        }
        return actionResult(response.result);
      },
      presentCall: (args) => ({
        card: "generic",
        title: "更新联系人资料",
        kind: "other",
        rawInput: clean(args?.contactId) || clean(args?.contactName),
      }),
    }));

    ctx.tools.register(defineTool({
      name: "suzu_software_action",
      description: "执行一项已登记的 Suzu Lives 软件动作，并返回执行状态和结果。status 为 completed 时表示动作已完成。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: SOFTWARE_ACTION_IDS,
          description: "已登记的软件动作 ID。",
        },
        input: {
          type: "json",
          description: "动作所需的 JSON 输入。navigate 使用 { destinationId }，set-theme 使用 { theme: \"light\" | \"dark\" }。create-contact 使用 { name, personaContent?, relationshipContent?, userContent? }；relationshipContent 是联系人视角的 SUZU.md，其中“你”指联系人 Agent，“用户”指软件用户。lookup-character-profile 使用 { query, candidateId? } 获取 Bangumi 角色名称、别名、作品、属性与简介；候选不唯一时用返回的 candidateId 重试。lookup-contact-avatar 使用 { query, candidateId?, contactId? 或 contactName? }：省略联系人时会下载头像预览并一并返回 Bangumi 角色资料和 avatarPath，提供联系人时会继续完成视觉构图、裁剪和设置。set-contact-avatar 使用 { contactId? 或 contactName?, avatarPath } 设置已取得的本机图片，并自动按主体构图保存为 PNG。",
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
        render: renderActionResult,
      },
      async execute(args, exec) {
        const action = clean(args?.action);
        if (!SOFTWARE_ACTION_IDS.includes(action)) {
          return {
            status: "invalid-request",
            content: "软件动作 ID 无效。",
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
        title: clean(args?.action) === "lookup-character-profile"
          ? "查找角色资料"
          : clean(args?.action) === "lookup-contact-avatar"
            ? "查找并设置联系人头像"
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
