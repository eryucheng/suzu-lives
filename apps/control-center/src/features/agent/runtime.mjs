export const CLAUDE_CODE_API_PROVIDERS = Object.freeze({
  deepseek: {
    label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic",
    models: { model: "deepseek-v4-pro[1m]", sonnet: "deepseek-v4-pro[1m]", opus: "deepseek-v4-pro[1m]", haiku: "deepseek-v4-flash", subagent: "deepseek-v4-flash", effort: "max" },
  },
  minimax: {
    label: "MiniMax（中国区）", baseUrl: "https://api.minimaxi.com/anthropic",
    models: { model: "MiniMax-M2.7", sonnet: "MiniMax-M2.7", opus: "MiniMax-M2.7", haiku: "MiniMax-M2.7", subagent: "MiniMax-M2.7" },
  },
  "bailian-coding": {
    label: "阿里百炼（Coding Plan）", baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    models: { model: "qwen3.8-max-preview", sonnet: "qwen3.8-max-preview", opus: "qwen3.8-max-preview", haiku: "qwen3.6-flash", subagent: "qwen3.7-max" },
  },
  "bailian-payg": {
    label: "阿里百炼（按量）", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    models: { model: "qwen3.8-max-preview", sonnet: "qwen3.8-max-preview", opus: "qwen3.8-max-preview", haiku: "qwen3.6-flash", subagent: "qwen3.7-max" },
  },
  kimi: {
    label: "Kimi Code", baseUrl: "https://api.kimi.com/coding/",
    models: { model: "kimi-for-coding", sonnet: "kimi-for-coding", opus: "kimi-for-coding", haiku: "kimi-for-coding", subagent: "kimi-for-coding", effort: "high" },
  },
  custom: { label: "自定义", baseUrl: "", models: {} },
});

export const API_BINDINGS = Object.freeze([
  { id: "image-generation", label: "生图", detail: "视觉工作台、Agent 生图与手机拍照式生图", types: ["dashscope"], selected: (bindings) => bindings["image-workbench"] || "" },
  { id: "image-vision", label: "理解图像", detail: "图片理解能力", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["image-vision"] || "" },
  { id: "sound", label: "声音", detail: "音色设计与文字转语音", types: ["dashscope"], selected: (bindings) => bindings["voice-design"] || bindings["voice-message"] || "" },
  { id: "video-understanding", label: "理解视频", detail: "视频理解能力", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["video-understanding"] || "" },
  { id: "memory-embedding", label: "记忆向量", detail: "用于长期记忆的语义召回；自动入库与整理复用“管理 → Claude Code API”的当前主模型。百炼向量连接默认使用 text-embedding-v4（1024 维）", types: ["openai-compatible", "dashscope"], selected: (bindings) => bindings["memory-embedding"] || "" },
]);

export async function loadApiServices(context) {
  try { context.state.apiServices = await context.api.connections.apiServicesSnapshot(); }
  catch (error) { context.setNotice(error?.message || "无法读取 API 设置。"); }
  context.render();
}

export async function loadClaudeCodeApi(context) {
  try { context.state.claudeCodeApi = await context.api.agentRuntime.claudeCodeApiSnapshot(); }
  catch (error) { context.setNotice(error?.message || "无法读取 Claude Code API 设置。"); }
  context.render();
}

export async function loadCapabilities(context) {
  try {
    context.state.capabilitySnapshot = await context.api.capabilities.snapshot();
    try { context.state.externalCapabilities = await context.api.externalCapabilities?.snapshot?.(); }
    catch (error) { context.setNotice(error?.message || "内置能力已读取，但暂时无法读取外部能力。 "); }
    try { context.state.apiServices = await context.api.connections.apiServicesSnapshot(); }
    catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取 API 选择。 "); }
    try { context.state.wechatSnapshot = await context.api.wechat?.snapshot?.(); }
    catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取微信连接状态。 "); }
    try {
      const snapshot = await context.api.capabilities.companionTargets();
      context.state.companionContacts = {
        contacts: Array.isArray(snapshot?.contacts) ? snapshot.contacts : [],
        status: snapshot?.status || "needs-root",
      };
    } catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取联系人范围。 "); }
  }
  catch (error) { context.setNotice(error?.message || "无法读取能力清单。"); }
  context.render();
}
