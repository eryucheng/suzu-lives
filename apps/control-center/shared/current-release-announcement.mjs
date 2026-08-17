// This is intentionally one current announcement, not a changelog.  Replace
// its copy before packaging a public release; the installed app supplies the
// version automatically and only presents it after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives 已更新",
  summary: "这次主要优化了日常使用体验和更新提示。",
  items: [
    "窄窗口时主导航会自动收起，为内容区域留出更多空间。",
    "主导航新增可直接进入对话的入口。",
    "软件会在启动后和每 12 小时检查一次更新。",
  ],
});
