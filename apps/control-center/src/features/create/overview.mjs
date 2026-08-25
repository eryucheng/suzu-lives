import { PRODUCT_FEATURES } from "../../../shared/product-features.mjs";

const CUSTOM_EMOJI_STICKER_SPACE = Object.freeze({
  detail: "添加和裁剪自定义表情，自动生成可编辑的检索信息，供聊天与 Agent 统一使用。",
  id: "stickers",
  label: "管理表情",
  symbol: "☺",
  title: "表情包工作台",
});

export const CREATE_SPACES = Object.freeze([
  Object.freeze({
    detail: "从提示词、参考资料到候选结果，在同一处收束一次视觉创作。",
    id: "visual",
    label: "进入创作",
    symbol: "◌",
    title: "视觉工作台",
  }),
  ...(PRODUCT_FEATURES.customEmojiStickers ? [CUSTOM_EMOJI_STICKER_SPACE] : []),
]);
