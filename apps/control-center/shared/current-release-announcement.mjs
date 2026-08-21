// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.2.1 → v0.2.2",
  summary: "本次更新内容：",
  items: [
    "修复主模型切换：联系人会按当前选择的服务、模型和 API Key 连接，不再错误沿用旧的服务配置。",
    "图片和视频会优先交给联系人启用的理解能力处理，再将理解结果提供给主模型；不支持视觉输入的主模型也能正常聊天。",
    "完善会话读取和内部上下文过滤，避免自动任务等非用户消息直接显示在聊天记录中。",
    "持续改善由 Suzu 自己管理的 Agent Core 会话与桌面交互稳定性，包括联系人切换、聊天滚动定位和启动流程。",
  ],
});
