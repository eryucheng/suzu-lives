export const CAPABILITY_CATEGORIES = Object.freeze([
  Object.freeze({ id: "perceive", label: "感知", detail: "图片、视频与时间" }),
  Object.freeze({ id: "companion", label: "陪伴", detail: "日常互动、联系与游戏" }),
  Object.freeze({ id: "act", label: "行动", detail: "现实中的工具与联系" }),
  Object.freeze({ id: "create", label: "创作", detail: "图片、声音与视觉资料" }),
]);

const HIDDEN_CAPABILITY_IDS = new Set(["proactive-contact"]);

export const WECHAT_DELIVERY_OPTIONS = Object.freeze([
  Object.freeze(["agent", "对方回复", "每次回复的正文，默认投递"]),
  Object.freeze(["attachments", "图片、音频与文件", "在聊天中交付的附件"]),
  Object.freeze(["permissions", "审批请求", "工具需要确认时的提醒，可回复“允许”或“拒绝”，默认投递"]),
  Object.freeze(["tools", "工具调用", "工具执行的过程与结果"]),
  Object.freeze(["thinking", "思考内容", "模型的思考过程"]),
  Object.freeze(["system", "系统通知", "停止、错误和运行状态"]),
  Object.freeze(["tokens", "用量统计", "本次回复的 Token 用量"]),
]);

export const WECHAT_TEXT_SEGMENTATION_OPTIONS = Object.freeze([
  Object.freeze(["paragraph", "空行分段"]),
  Object.freeze(["sentence", "句子分段"]),
]);

export function wechatConnectionSettings(snapshot) {
  const raw = snapshot && typeof snapshot === "object" ? snapshot : {};
  const delivery = raw.delivery && typeof raw.delivery === "object" ? raw.delivery : {};
  return {
    delivery: Object.fromEntries(WECHAT_DELIVERY_OPTIONS.map(([key]) => [key, delivery[key] === undefined ? ["agent", "permissions"].includes(key) : delivery[key] === true])),
    textSegmentation: raw.textSegmentation === "sentence" ? "sentence" : "paragraph",
  };
}

export function capabilityCategory(capability) {
  return { category: "act", ...(capability || {}) }.category;
}

export function capabilityVisibleInCatalog(capability) {
  return !HIDDEN_CAPABILITY_IDS.has(String(capability?.id || "").trim());
}

export function createWechatConnectionCapability() {
  return {
    id: "wechat-connection",
    name: "连接微信",
    description: "设置已连接微信接收的消息类型。",
    category: "companion",
    enabled: true,
    softwareConnector: true,
  };
}

export function capabilityOverview({ capabilitySnapshot, wechatSnapshot } = {}) {
  const builtIn = Array.isArray(capabilitySnapshot?.capabilities) ? capabilitySnapshot.capabilities : [];
  const capabilities = [...builtIn, createWechatConnectionCapability(wechatSnapshot)]
    .filter(capabilityVisibleInCatalog);
  const categories = CAPABILITY_CATEGORIES.filter((category) => capabilities.some((capability) => capabilityCategory(capability) === category.id));
  return { capabilities, categories };
}
