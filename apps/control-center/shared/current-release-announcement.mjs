// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.1.4 → v0.1.5",
  summary: "本次更新内容（最近会比较频繁更新）：",
  items: [
    "优化主动关心链机制，更稳定。",
    "自动任务和内部安排不再混进正常聊天气泡。",
    "优化界面显示：窗口变窄时左侧导航会自动收起；“今天”下面可直接进入对话。",
    "软件会静默检查更新；更新安装并重新打开后，会显示本次公告。",
    "DeepSeek V4 费用估算已同步最新官方峰谷价格；其他模型的价格映射仍可自行维护。",
  ],
});
