// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.1.x → v0.2.5",
  summary: "本次更新内容：",
  items: [
    "底层已切换为由 Suzu 自己管理的本机 Agent Core 运行时，不再需要 Claude Code。",
    "从 0.1.x 升级时，安装器会提供一次性迁移助手：旧对话会转换为原生 Agent Core 会话，验证成功后才清理对应旧 JSONL。",
    "兼容的联系人资料、长期记忆和可验证的连接会保留或接管；无法安全映射的数据不会被静默删除。",
    "旧 Claude 登录状态不会迁移到新版；请在新版的“主模型”中配置所用模型服务和 API Key。",
    "优化了 UI 界面。",
    "修复了一些已知问题。",
  ],
});
