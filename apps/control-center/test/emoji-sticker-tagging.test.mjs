import assert from "node:assert/strict";
import test from "node:test";

import {
  completeEmojiStickerMetadata,
  emojiStickerTagSchema,
  emojiStickerTagSystemPrompt,
} from "../electron/services/emoji-sticker-tagging.mjs";

const IMAGE = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "binary");

test("one-shot sticker tagging fills only blank fields and sends the image through the transient runtime", async () => {
  const calls = [];
  const runtime = {
    async runTransientInference(value) {
      calls.push(value);
      return {
        available: true,
        result: {
          ok: true,
          output: {
            description: "角色捂脸，适合回应尴尬场面。",
            keywords: ["角色", "捂脸", "尴尬"],
            name: "捂脸尴尬",
          },
        },
      };
    },
  };

  const result = await completeEmojiStickerMetadata({
    data: IMAGE,
    fileName: "sticker.webp",
    metadata: {
      description: "用户填写的说明。",
      keywords: ["我错了"],
    },
    mimeType: "image/webp",
    runtime,
  });

  assert.equal(result.inferred, true);
  assert.equal(result.metadata.name, "捂脸尴尬");
  assert.equal(result.metadata.description, "用户填写的说明。");
  assert.deepEqual(result.metadata.keywords, ["我错了"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, "sticker.metadata.v2");
  assert.equal(calls[0].schemaName, "sticker-metadata-v2");
  assert.equal(calls[0].content[1].type, "image");
  assert.equal(calls[0].content[1].data, IMAGE.toString("base64"));
});

test("complete sticker metadata skips the runtime when every core semantic field is already present", async () => {
  let called = false;
  const metadata = {
    description: "完整描述",
    keywords: ["角色", "点头", "开心"],
    name: "点头确认",
  };
  const result = await completeEmojiStickerMetadata({
    data: IMAGE,
    metadata,
    runtime: { runTransientInference: async () => { called = true; } },
  });
  assert.equal(result.inferred, false);
  assert.equal(called, false);
  assert.deepEqual(result.metadata.keywords, ["角色", "点头", "开心"]);
});

test("sticker metadata prompt and schema keep generated information open-ended", () => {
  assert.match(emojiStickerTagSystemPrompt, /自由的短词/u);
  assert.match(emojiStickerTagSystemPrompt, /不需要套用固定词库/u);
  assert.equal(emojiStickerTagSchema.properties.keywords.maxItems, 12);
  assert.deepEqual(emojiStickerTagSchema.required, ["name", "description", "keywords"]);
  assert.equal(Object.hasOwn(emojiStickerTagSchema.properties, "tags"), false);
});
