export { TEXT_MODEL_PROVIDERS } from "@suzu-lives/suzu-agent-runtime/model-capability-catalog";

export const API_BINDINGS = Object.freeze([
  { id: "image-generation", label: "生图", detail: "视觉工作台、Agent 生图和手机拍照式画面；按已选 API 的协议调用", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["image-workbench"] || "" },
  { id: "image-vision", label: "理解图像", detail: "图片理解能力", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["image-vision"] || "" },
  { id: "voice-message", label: "语音消息", detail: "联系人文字转语音；适配器决定请求协议，音色决定模型和声音", types: ["tts-api", "openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["voice-message"] || "" },
  { id: "realtime-asr", label: "语音识别", detail: "语音通话中把你说的语音转成文字；地址、Key、模型由所选连接提供", types: ["asr-api", "dashscope"], selected: (bindings) => bindings["realtime-asr"] || "" },
  { id: "video-understanding", label: "理解视频", detail: "视频理解能力", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["video-understanding"] || "" },
  { id: "memory-embedding", label: "记忆向量", detail: "用于长期记忆的语义召回；Agent Core 会将召回结果作为当前请求的动态上下文。向量连接默认使用 text-embedding-v4（1024 维）", types: ["openai-compatible", "dashscope"], selected: (bindings) => bindings["memory-embedding"] || "" },
]);

const runtimeSnapshotTasks = new WeakMap();

/**
 * Read the selected main model once for this renderer lifetime. The Electron
 * configuration service publishes the same snapshot to the runtime, where
 * conversation attachment routing uses it without opening Agent Core again.
 * A successful model save replaces state.agentRuntime with a fresh snapshot.
 */
export async function ensureAgentRuntimeConfig(context) {
  const runtimeState = context?.state;
  if (!runtimeState || typeof runtimeState !== "object") {
    throw new TypeError("读取主模型配置需要应用状态。");
  }
  if (runtimeState.agentRuntime) return runtimeState.agentRuntime;
  const active = runtimeSnapshotTasks.get(runtimeState);
  if (active) return active;
  const task = Promise.resolve().then(() => context.api.agentRuntime.snapshot());
  runtimeSnapshotTasks.set(runtimeState, task);
  try {
    const snapshot = await task;
    runtimeState.agentRuntime = snapshot;
    return snapshot;
  } finally {
    if (runtimeSnapshotTasks.get(runtimeState) === task) runtimeSnapshotTasks.delete(runtimeState);
  }
}

export async function loadApiServices(context) {
  try { context.state.apiServices = await context.api.connections.apiServicesSnapshot(); }
  catch (error) { context.setNotice(error?.message || "无法读取 API 设置。"); }
  context.render();
}

export async function loadAgentRuntimeConfig(context) {
  try { await ensureAgentRuntimeConfig(context); }
  catch (error) { context.setNotice(error?.message || "无法读取主模型设置。"); }
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
    try { context.state.qqSnapshot = await context.api.qq?.snapshot?.(); }
    catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取 QQ 连接状态。 "); }
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
