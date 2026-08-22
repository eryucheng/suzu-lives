// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.2.7 → v0.2.8",
  summary: "本次更新内容：",
  items: [
    "优化 Agent 对话流程与消息显示，改善队列、主动关心、历史记录和会话清理的稳定性。",
    "语音能力改为按服务、音色和联系人配置，支持更多内置服务及自定义协议。",
    "完善图片、视频、文件与视觉理解相关能力，并更新设置和管理界面。",
    "修复了一些已知问题。",
  ],
});
