// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.2.9 → v0.2.10",
  summary: "本次更新内容：",
  items: [
    "优化 Suzu Agent Core 对话流程：发送后可继续输入，修复输入焦点与交互恢复问题。",
    "联系人默认不使用 Unicode emoji，消息显示和流式回复的稳定性进一步改善。",
    "API 连接可直接创建 DashScope 原生连接；图片生成请求失败时会给出安全、可定位的响应诊断。",
    "完善语音、图片、联系人与主动关心等能力的体验和稳定性。",
  ],
});
