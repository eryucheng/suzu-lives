export const CAPABILITY_CATEGORIES = Object.freeze([
  Object.freeze({ id: "perceive", label: "感知", detail: "图片、视频与时间" }),
  Object.freeze({ id: "companion", label: "陪伴", detail: "日常互动、联系与游戏" }),
  Object.freeze({ id: "act", label: "行动", detail: "现实中的工具与联系" }),
  Object.freeze({ id: "create", label: "创作", detail: "图片、声音与视觉资料" }),
]);

const HIDDEN_CAPABILITY_IDS = new Set(["proactive-contact"]);

export const WECHAT_DELIVERY_OPTIONS = Object.freeze([
  Object.freeze(["agent", "Agent 的说话内容", "最终回复，默认投递"]),
  Object.freeze(["attachments", "Hook / 上下文", "当前会话流出现这类记录时投递"]),
  Object.freeze(["permissions", "审批提示", "工具需要确认时提醒；可回复“允许”或“拒绝”，默认投递"]),
  Object.freeze(["tools", "工具调用", "工具调用的过程与细节"]),
  Object.freeze(["thinking", "思考内容", "仅在你明确需要时投递"]),
  Object.freeze(["system", "系统消息", "停止、错误和系统状态"]),
  Object.freeze(["tokens", "Token 用量", "本次回复的用量摘要"]),
]);

export function wechatConnectionSettings(snapshot) {
  const raw = snapshot && typeof snapshot === "object" ? snapshot : {};
  const delivery = raw.delivery && typeof raw.delivery === "object" ? raw.delivery : {};
  return {
    enabled: raw.enabled === true,
    linkedContacts: Number(raw.linkedContacts) || 0,
    delivery: Object.fromEntries(WECHAT_DELIVERY_OPTIONS.map(([key]) => [key, delivery[key] === undefined ? ["agent", "permissions"].includes(key) : delivery[key] === true])),
  };
}

export function capabilityCategory(capability) {
  return { category: "act", ...(capability || {}) }.category;
}

export function capabilityVisibleInCatalog(capability) {
  return !HIDDEN_CAPABILITY_IDS.has(String(capability?.id || "").trim());
}

export function createWechatConnectionCapability(snapshot) {
  const current = wechatConnectionSettings(snapshot);
  return {
    id: "wechat-connection",
    name: "连接微信",
    description: "把指定对话连接到手机微信。",
    category: "companion",
    enabled: current.enabled,
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
