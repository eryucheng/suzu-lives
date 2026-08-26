import fs from "node:fs/promises";
import path from "node:path";

import { inspectEmojiSticker } from "./emoji-sticker-library.mjs";
import { normalizeEmojiStickerMetadata } from "./emoji-sticker-metadata.mjs";

export const BUILTIN_EMOJI_STICKER_CATEGORY = Object.freeze({
  id: "suzu",
  name: "Suzu 内置表情",
  type: "builtin",
});

const CREATED_AT = "2026-08-26T00:00:00.000Z";

function sticker(value) {
  return Object.freeze({
    ...value,
    builtIn: true,
    category: BUILTIN_EMOJI_STICKER_CATEGORY.type,
    categoryId: BUILTIN_EMOJI_STICKER_CATEGORY.id,
    categoryName: BUILTIN_EMOJI_STICKER_CATEGORY.name,
    createdAt: CREATED_AT,
    metadata: Object.freeze(normalizeEmojiStickerMetadata(value.metadata)),
  });
}

export const BUILTIN_EMOJI_STICKERS = Object.freeze([
  sticker({
    fileName: "01-thinking.png",
    id: "builtin:suzu:thinking",
    metadata: {
      name: "认真思考",
      description: "Suzu 托腮抬眼认真思考，适合表示正在琢磨、需要一点时间或“让我想想”。",
      keywords: ["思考", "琢磨", "让我想想", "等一下", "分析", "考虑"],
    },
  }),
  sticker({
    fileName: "02-smug.png",
    id: "builtin:suzu:smug",
    metadata: {
      name: "小小得意",
      description: "Suzu 抱臂露出有点得意的笑，适合表示得瑟、事情办成了或小骄傲。",
      keywords: ["得意", "得瑟", "嘿嘿", "骄傲", "办成了", "成功"],
    },
  }),
  sticker({
    fileName: "03-panic.png",
    id: "builtin:suzu:panic",
    metadata: {
      name: "慌张了",
      description: "Suzu 瞪大眼睛紧张握拳，适合表示震惊、出错、完蛋了或突然手忙脚乱。",
      keywords: ["慌张", "震惊", "完蛋", "出错", "紧张", "手忙脚乱"],
    },
  }),
  sticker({
    fileName: "04-got-it.png",
    id: "builtin:suzu:got-it",
    metadata: {
      name: "收到",
      description: "Suzu 精神满满地敬礼回应，适合表示收到、明白、交给我或没问题。",
      keywords: ["收到", "明白", "交给我", "没问题", "好的", "执行"],
    },
  }),
  sticker({
    fileName: "05-sleepy.png",
    id: "builtin:suzu:sleepy",
    metadata: {
      name: "困困",
      description: "Suzu 闭眼打哈欠准备休息，适合表示困倦、想睡觉、晚安或需要休息。",
      keywords: ["困", "睡觉", "休息", "晚安", "打哈欠", "累"],
    },
  }),
  sticker({
    fileName: "06-comfort.png",
    id: "builtin:suzu:comfort",
    metadata: {
      name: "抱抱你",
      description: "Suzu 张开双手送出温柔拥抱，适合表示安慰、陪伴、心疼或“我在这里”。",
      keywords: ["安慰", "抱抱", "陪伴", "心疼", "我在", "温柔"],
    },
  }),
]);

function clean(value) {
  return String(value ?? "").trim();
}

export function resolveBuiltinEmojiStickerAssetsRoot(appRoot) {
  const root = clean(appRoot);
  if (!root) throw new Error("缺少 Suzu Lives 应用目录。 ");
  return path.join(path.resolve(root), "resources", "stickers", "builtin", "suzu");
}

export function createBuiltinEmojiStickerLibrary({ assetsRoot, fsOps = fs } = {}) {
  const rawRoot = clean(assetsRoot);
  if (!rawRoot) throw new Error("缺少内置表情资源目录。 ");
  const root = path.resolve(rawRoot);
  const definitions = new Map(BUILTIN_EMOJI_STICKERS.map((item) => [item.id, item]));

  const asset = async (id) => {
    const stickerId = clean(id);
    const definition = definitions.get(stickerId);
    if (!definition) throw new Error("找不到这张内置表情。 ");
    const target = path.join(root, definition.fileName);
    const inspected = await inspectEmojiSticker(target, { fsOps });
    return Object.freeze({
      ...definition,
      mimeType: inspected.mimeType,
      path: inspected.source,
      size: inspected.size,
    });
  };

  const snapshot = async () => {
    try {
      const items = await Promise.all(BUILTIN_EMOJI_STICKERS.map((item) => asset(item.id)));
      return Object.freeze({
        categories: Object.freeze([{ ...BUILTIN_EMOJI_STICKER_CATEGORY, count: items.length }]),
        items: Object.freeze(items),
        status: items.length ? "ready" : "empty",
      });
    } catch (error) {
      return Object.freeze({
        categories: Object.freeze([{ ...BUILTIN_EMOJI_STICKER_CATEGORY, count: 0 }]),
        items: Object.freeze([]),
        message: error instanceof Error ? error.message : "无法读取内置表情资源。",
        status: "invalid",
      });
    }
  };

  return Object.freeze({
    asset,
    read: async (id) => {
      const item = await asset(id);
      return Object.freeze({ ...item, data: await fsOps.readFile(item.path) });
    },
    root,
    snapshot,
  });
}
