import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEmojiStickerAgentCapabilityAdapter } from "../electron/services/emoji-sticker-agent-capability.mjs";
import {
  createBuiltinEmojiStickerLibrary,
} from "../electron/services/builtin-emoji-sticker-library.mjs";
import { createEmojiStickerCatalog } from "../electron/services/emoji-sticker-catalog.mjs";
import {
  createEmojiStickerLibrary,
  resolveEmojiStickerLibraryRoot,
} from "../electron/services/emoji-sticker-library.mjs";
import { conversationDisplayMessages } from "../electron/services/conversation-reader.mjs";

const WEBP_HEADER = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "binary");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-sticker-agent-"));
  const dataRoot = path.join(root, "data");
  const library = createEmojiStickerLibrary({ libraryRoot: resolveEmojiStickerLibraryRoot(dataRoot) });
  const grin = await library.add({
    data: WEBP_HEADER,
    fileName: "grin.webp",
    mimeType: "image/webp",
    metadata: {
      name: "傻笑猫",
      description: "露出牙齿傻笑，适合表达得瑟、调皮或尴尬。",
      keywords: ["猫", "傻笑", "露齿笑", "得瑟", "调皮", "尴尬"],
    },
  });
  const surprise = await library.add({
    data: WEBP_HEADER,
    fileName: "surprise.webp",
    mimeType: "image/webp",
    metadata: {
      name: "震惊猫",
      description: "瞪大眼睛表示惊讶。",
      keywords: ["猫", "震惊", "惊讶"],
    },
  });
  const deliveries = [];
  const builtinLibrary = createBuiltinEmojiStickerLibrary({
    assetsRoot: fileURLToPath(new URL("../resources/stickers/builtin/suzu", import.meta.url)),
  });
  const catalog = createEmojiStickerCatalog({ builtinLibrary, customLibrary: library });
  const adapter = createEmojiStickerAgentCapabilityAdapter({
    catalog,
    deliver: async (request) => {
      deliveries.push(request);
      const item = request.input.items[0];
      return {
        status: "ok",
        type: "suzu-conversation-attachment",
        receiptId: "attachment-sticker-test",
        items: [{ ...item, mediaSource: request.mediaSource, size: WEBP_HEADER.length }],
      };
    },
  });
  return {
    adapter,
    catalog,
    deliveries,
    grinId: grin.addedId,
    surpriseId: surprise.addedId,
  };
}

function invoke(adapter, action, input) {
  return adapter({
    action: { action },
    capability: { id: "emoji-sticker" },
    context: {
      input,
      projectRoot: "D:\\Temp\\suzu-sticker-agent-project",
      sessionId: "session-sticker-agent",
    },
    lifecycle: "invoke",
  });
}

test("Agent sticker recommendation and search return small candidates without local paths", async () => {
  const { adapter, catalog, surpriseId } = await fixture();

  const snapshot = await catalog.snapshot();
  assert.equal(snapshot.categories.find((category) => category.type === "builtin")?.count, 6);
  assert.equal(snapshot.categories.find((category) => category.type === "favorites")?.count, 2);

  const recommended = await invoke(adapter, "recommend", { intent: "小小得意", limit: 3 });
  assert.equal(recommended.status, "matched");
  assert.equal(recommended.items[0].id, "builtin:suzu:smug");
  assert.equal(recommended.items[0].name, "小小得意");
  assert.equal(recommended.items[0].category, "builtin");
  assert.equal(recommended.items[0].categoryName, "Suzu 内置表情");
  assert.equal(Object.hasOwn(recommended.items[0], "path"), false);
  assert.equal(Object.hasOwn(recommended.items[0], "fileName"), false);

  const searched = await invoke(adapter, "search", { query: "惊讶" });
  assert.equal(searched.status, "matched");
  assert.equal(searched.items[0].id, surpriseId);
  assert.equal(searched.items[0].category, "favorites");

  const empty = await invoke(adapter, "search", { query: "完全不存在的内容" });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.status, "empty");
});

test("Agent sticker send delivers the selected built-in asset as a sticker receipt", async () => {
  const { adapter, deliveries } = await fixture();
  const result = await invoke(adapter, "send", { id: "builtin:suzu:got-it" });

  assert.equal(result.status, "ok");
  assert.equal(result.type, "suzu-conversation-attachment");
  assert.equal(result.sticker.id, "builtin:suzu:got-it");
  assert.equal(result.sticker.category, "builtin");
  assert.equal(result.sticker.name, "收到");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].mediaSource, "sticker");
  assert.equal(deliveries[0].input.items[0].kind, "image");
  assert.match(deliveries[0].input.items[0].path, /04-got-it\.png$/u);
});

test("Agent sticker receipt renders as a sticker bubble instead of a generic image", () => {
  const filePath = "D:\\Temp\\suzu-sticker-agent-project\\grin.webp";
  const receipt = {
    status: "ok",
    type: "suzu-conversation-attachment",
    receiptId: "attachment-sticker-render",
    items: [{
      kind: "image",
      fileName: "grin.webp",
      mediaSource: "sticker",
      path: filePath,
      size: WEBP_HEADER.length,
    }],
  };
  const messages = conversationDisplayMessages([{
    event: {
      type: "tool/result",
      seq: 5,
      time: "2026-08-26T00:00:00.000Z",
      surfaceOp: "append",
      data: {
        message: {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
        },
      },
    },
  }], 500, { dataRoot: "D:\\Temp\\suzu-sticker-agent-project" });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "assistant");
  assert.equal(messages[0].blocks[0].mediaKind, "sticker");
  assert.equal(messages[0].blocks[0].mediaSource, "sticker");
  assert.equal(messages[0].blocks[0].filePath, filePath);
});
