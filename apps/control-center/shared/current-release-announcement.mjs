// This is intentionally one current announcement, not a changelog. Replace
// its version range and copy before packaging a release; it is only presented
// after an upgrade.
export const CURRENT_RELEASE_ANNOUNCEMENT = Object.freeze({
  title: "Suzu Lives v0.3.1 → v0.3.2",
  summary: "",
  items: [
    "新增 Suzu 助手模型与 API 配置能力，可直接协助完成主模型选择、连接信息和密钥设置。",
    "完善联系人创建流程，Suzu 助手可查询角色资料、匹配头像并智能裁剪。",
    "新增热门模型价格目录，费用统计仅展示实际使用过的模型，并支持分档价格、缓存计费和汇率折算。",
    "优化长会话、对话与语音通话体验，提升整体稳定性。",
    "新增 MJ 蜘蛛侠彩蛋，在应用内连续输入“mj”即可触发。",
  ],
});
