// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.2.6 → v0.2.7",
  summary: "本次更新内容：",
  items: [
    "修复主动关心内部任务完成后可能影响后续对话的问题。",
    "提升 Suzu Agent Core 会话事件处理的稳定性。",
  ],
});
