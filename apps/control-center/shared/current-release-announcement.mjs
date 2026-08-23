// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.2.8 → v0.2.9",
  summary: "本次更新内容：",
  items: [
    "修复正式发布前的公告测试，不再让版本文案阻断安装包发布。",
    "优化 Agent 对话流程与消息显示，改善队列、主动关心、历史记录和会话清理的稳定性。",
    "语音能力改为按服务、音色和联系人配置，支持更多内置服务及自定义协议。",
    "完善图片、视频、文件与视觉理解相关能力，并更新设置和管理界面。",
    "修复了一些已知问题。",
  ],
});
