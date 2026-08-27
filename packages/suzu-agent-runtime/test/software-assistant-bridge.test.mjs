import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuSoftwareAssistantBridge } from "../src/software-assistant-bridge.mjs";

function registeredBridge(transport, config = {}) {
  const registered = new Map();
  createSuzuSoftwareAssistantBridge({ transport }).apply({
    tools: {
      register(tool) { registered.set(tool.name, tool); },
    },
  }, config);
  return registered;
}

const EXECUTION = Object.freeze({
  agent: { session: { id: "suzu-software-assistant" } },
  callId: "call-1",
  rootCallId: "root-1",
});

test("software assistant bridge exposes product, contact, and registered action tools", async () => {
  const requests = [];
  const tools = registeredBridge({
    async request(event, payload, options) {
      requests.push({ event, payload, options });
      if (event === "SoftwareAssistantStatus") return { available: true, result: { content: "主题：浅色" } };
      if (event === "SoftwareAssistantPageSearch") {
        return {
          available: true,
          result: {
            status: "completed",
            content: "相关页面：\n- 壁纸（wallpaper）：设置 · 壁纸",
            data: { query: "壁纸", results: [{ id: "wallpaper", title: "壁纸", detail: "设置 · 壁纸" }] },
          },
        };
      }
      if (event === "SoftwareAssistantContactSearch") {
        return { available: true, result: { status: "completed", content: "玛琪玛（contact-makima）", data: { contacts: [{ contactId: "contact-makima", name: "玛琪玛" }] } } };
      }
      if (event === "SoftwareAssistantContactRead") {
        return { available: true, result: { status: "completed", content: "已读取玛琪玛的人设。", data: { files: [{ section: "persona", content: "测试人设" }] } } };
      }
      if (event === "SoftwareAssistantContactUpdate") {
        return { available: true, result: { status: "completed", content: "已更新玛琪玛的人设。", data: { updatedFields: ["persona"] } } };
      }
      return { available: true, result: { status: "completed", content: "已切换为深色主题。", data: { theme: "dark" } } };
    },
  }, { timeoutMs: 2_000 });

  assert.deepEqual([...tools.keys()], [
    "suzu_software_status",
    "suzu_software_page_search",
    "suzu_main_model_status",
    "suzu_main_model_save",
    "suzu_api_connection_search",
    "suzu_api_connection_save",
    "suzu_contact_search",
    "suzu_contact_read",
    "suzu_contact_update",
    "suzu_software_action",
  ]);
  assert.equal(tools.get("suzu_software_status").description, "读取当前 Suzu Lives 的主题、版本、更新状态、数据目录和程序位置。");
  assert.equal(tools.get("suzu_software_page_search").description, "按名称或用途查找 Suzu Lives 已登记的页面，返回页面 ID 和界面路径。");
  assert.equal(tools.get("suzu_software_page_search").parameters.properties.query.description, "要查找的页面名称、功能或设置。");
  assert.match(tools.get("suzu_contact_search").description, /联系人工作区/u);
  assert.deepEqual(tools.get("suzu_contact_read").parameters.properties.section.enum, ["all", "relationship", "persona", "user"]);
  assert.deepEqual(tools.get("suzu_contact_update").parameters.properties.permissionMode.enum, ["danger-full-access", "workspace-write", "read-only"]);
  assert.deepEqual(tools.get("suzu_contact_update").parameters.properties.reasoningEffort.enum, ["off", "low", "high", "max"]);
  assert.equal(tools.get("suzu_software_action").description, "执行一项已登记的 Suzu Lives 软件动作，并返回执行状态和结果。status 为 completed 时表示动作已完成。");
  assert.equal(tools.get("suzu_software_action").parameters.properties.action.description, "已登记的软件动作 ID。");
  assert.deepEqual(tools.get("suzu_software_action").parameters.properties.action.enum, [
    "navigate",
    "set-theme",
    "create-contact",
    "lookup-character-profile",
    "lookup-contact-avatar",
    "set-contact-avatar",
  ]);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /avatarPath/u);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /candidateId/u);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /视觉构图/u);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /Bangumi.*简介/u);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /一并返回.*avatarPath/u);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /relationshipContent/u);
  assert.match(tools.get("suzu_software_action").parameters.properties.input.description, /relationshipContent.*“你”指联系人 Agent.*“用户”指软件用户/u);
  assert.match(tools.get("suzu_contact_update").parameters.properties.relationshipContent.description, /“你”指联系人 Agent.*“用户”指软件用户/u);
  assert.equal(tools.get("suzu_software_action").presentCall({ action: "lookup-contact-avatar", input: { query: "玛奇玛" } }).title, "查找并设置联系人头像");
  assert.equal(tools.get("suzu_software_action").presentCall({ action: "lookup-character-profile", input: { query: "玛奇玛" } }).title, "查找角色资料");
  assert.deepEqual(await tools.get("suzu_software_status").execute({}, EXECUTION), { content: "主题：浅色" });
  assert.deepEqual(await tools.get("suzu_software_page_search").execute({ query: "壁纸" }, EXECUTION), {
    status: "completed",
    content: "相关页面：\n- 壁纸（wallpaper）：设置 · 壁纸",
    data: { query: "壁纸", results: [{ id: "wallpaper", title: "壁纸", detail: "设置 · 壁纸" }] },
  });
  assert.deepEqual(await tools.get("suzu_contact_search").execute({ query: "玛琪玛" }, EXECUTION), {
    status: "completed",
    content: "玛琪玛（contact-makima）",
    data: { contacts: [{ contactId: "contact-makima", name: "玛琪玛" }] },
  });
  assert.deepEqual(await tools.get("suzu_contact_read").execute({ contactId: "contact-makima", section: "persona" }, EXECUTION), {
    status: "completed",
    content: "已读取玛琪玛的人设。",
    data: { files: [{ section: "persona", content: "测试人设" }] },
  });
  assert.deepEqual(await tools.get("suzu_contact_update").execute({ contactId: "contact-makima", personaContent: "新人设" }, EXECUTION), {
    status: "completed",
    content: "已更新玛琪玛的人设。",
    data: { updatedFields: ["persona"] },
  });
  assert.deepEqual(await tools.get("suzu_software_action").execute({ action: "set-theme", input: { theme: "dark" } }, EXECUTION), {
    status: "completed",
    content: "已切换为深色主题。",
    data: { theme: "dark" },
  });
  const renderedAction = tools.get("suzu_software_action").output.render({}, {
    status: "completed",
    content: "已找到头像预览。",
    data: {
      contactId: "contact-makima",
      avatarPath: "D:\\Suzu Lives\\avatar-previews\\makima.webp",
    },
  });
  assert.equal(renderedAction.length, 1);
  assert.match(renderedAction[0].text, /状态：completed/u);
  assert.match(renderedAction[0].text, /contact-makima/u);
  assert.match(renderedAction[0].text, /makima\.webp/u);
  assert.deepEqual(requests, [
    {
      event: "SoftwareAssistantStatus",
      payload: { sessionId: "suzu-software-assistant", callId: "call-1", rootCallId: "root-1" },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantPageSearch",
      payload: {
        sessionId: "suzu-software-assistant",
        callId: "call-1",
        rootCallId: "root-1",
        query: "壁纸",
      },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantContactSearch",
      payload: {
        sessionId: "suzu-software-assistant",
        callId: "call-1",
        rootCallId: "root-1",
        query: "玛琪玛",
      },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantContactRead",
      payload: {
        sessionId: "suzu-software-assistant",
        callId: "call-1",
        rootCallId: "root-1",
        input: { contactId: "contact-makima", section: "persona" },
      },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantContactUpdate",
      payload: {
        sessionId: "suzu-software-assistant",
        callId: "call-1",
        rootCallId: "root-1",
        input: { contactId: "contact-makima", personaContent: "新人设" },
      },
      options: { timeoutMs: 2_000 },
    },
    {
      event: "SoftwareAssistantAction",
      payload: {
        sessionId: "suzu-software-assistant",
        callId: "call-1",
        rootCallId: "root-1",
        action: "set-theme",
        input: { theme: "dark" },
      },
      options: { timeoutMs: 2_000 },
    },
  ]);
});

test("software assistant bridge validates registered action IDs before Electron dispatch", async () => {
  let requests = 0;
  const tools = registeredBridge({
    async request() {
      requests += 1;
      return { available: true, result: {} };
    },
  });

  await assert.rejects(
    tools.get("suzu_software_action").execute({
      action: "delete every file",
      input: {},
    }, EXECUTION),
    { code: "INVALID_ARGS" },
  );
  assert.deepEqual(await tools.get("suzu_software_page_search").execute({ query: "  " }, EXECUTION), {
    status: "invalid-request",
    content: "请提供要查找的页面、功能或设置。",
    data: { results: [] },
  });
  assert.equal(requests, 0);
});

test("software assistant bridge saves model and API credentials without presenting or returning the key", async () => {
  const requests = [];
  const secret = "sk-local-test-secret";
  const tools = registeredBridge({
    async request(event, payload, options) {
      requests.push({ event, payload, options });
      if (event === "SoftwareAssistantMainModelStatus") {
        return {
          available: true,
          result: {
            status: "completed",
            content: "主模型服务：DeepSeek\n模型：deepseek-v4-flash\n连接状态：密钥已保存",
            data: { model: { providerId: "deepseek", model: "deepseek-v4-flash", hasApiKey: true } },
          },
        };
      }
      if (event === "SoftwareAssistantMainModelSave") {
        return {
          available: true,
          result: {
            status: "completed",
            content: "已保存主模型“DeepSeek · deepseek-v4-flash”。",
            data: { model: { providerId: "deepseek", model: "deepseek-v4-flash", hasApiKey: true } },
          },
        };
      }
      if (event === "SoftwareAssistantApiConnectionSearch") {
        return {
          available: true,
          result: {
            status: "completed",
            content: "已保存的 API 连接：\n- DeepSeek（deepseek）：OpenAI Compatible · deepseek-v4-flash",
            data: { connections: [{ id: "deepseek", name: "DeepSeek", model: "deepseek-v4-flash", configured: true }] },
          },
        };
      }
      return {
        available: true,
        result: {
          status: "completed",
          content: "已保存 API 连接“DeepSeek”，默认模型为 deepseek-v4-flash。",
          data: { connection: { id: "deepseek", name: "DeepSeek", model: "deepseek-v4-flash", configured: true } },
        },
      };
    },
  }, { timeoutMs: 2_000 });

  assert.deepEqual(tools.get("suzu_main_model_save").parameters.properties.provider.enum, [
    "deepseek", "minimax", "bailian-coding", "bailian-payg", "kimi", "kimi-api", "moonshot", "tongyi", "dashscope", "bailian", "openai", "zhipu", "ollama", "custom",
  ]);
  assert.deepEqual(tools.get("suzu_api_connection_save").parameters.properties.provider.enum, [
    "openai", "deepseek", "moonshot", "zhipu", "tongyi", "ollama", "dashscope", "custom-openai", "tts-api", "asr-api", "generic-api",
  ]);
  const mainInput = { provider: "deepseek", apiKey: secret };
  const apiInput = { provider: "deepseek", apiKey: secret, model: "deepseek-v4-flash" };
  assert.doesNotMatch(JSON.stringify(tools.get("suzu_main_model_save").presentCall(mainInput)), /sk-local-test-secret/u);
  assert.doesNotMatch(JSON.stringify(tools.get("suzu_api_connection_save").presentCall(apiInput)), /sk-local-test-secret/u);

  const results = [
    await tools.get("suzu_main_model_status").execute({}, EXECUTION),
    await tools.get("suzu_main_model_save").execute(mainInput, EXECUTION),
    await tools.get("suzu_api_connection_search").execute({ query: "DeepSeek" }, EXECUTION),
    await tools.get("suzu_api_connection_save").execute(apiInput, EXECUTION),
  ];
  assert.doesNotMatch(JSON.stringify(results), /sk-local-test-secret/u);
  assert.equal(requests[1].payload.input.apiKey, secret);
  assert.equal(requests[3].payload.input.apiKey, secret);
  assert.deepEqual(requests.map((request) => request.event), [
    "SoftwareAssistantMainModelStatus",
    "SoftwareAssistantMainModelSave",
    "SoftwareAssistantApiConnectionSearch",
    "SoftwareAssistantApiConnectionSave",
  ]);
});

test("software assistant bridge reports an unavailable parent without inventing an action outcome", async () => {
  const tools = registeredBridge({
    async request() { return { available: false, result: null }; },
  });

  assert.deepEqual(await tools.get("suzu_software_action").execute({ action: "navigate", input: { destinationId: "settings" } }, EXECUTION), {
    status: "parent-unavailable",
    content: "Suzu Lives 软件操作桥当前不可用。",
    data: null,
  });
});
