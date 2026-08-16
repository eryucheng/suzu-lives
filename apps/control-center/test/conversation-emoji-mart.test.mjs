import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("..", import.meta.url);

test("conversation uses a local Apple Emoji Mart picker with search, collection, and favorites tabs", async () => {
  const [page, styles, packageJson] = await Promise.all([
    readFile(new URL("src/react/conversation-page.jsx", ROOT), "utf8"),
    readFile(new URL("src/styles/conversation.css", ROOT), "utf8"),
    readFile(new URL("package.json", ROOT), "utf8"),
  ]);

  assert.match(page, /import emojiMartData from "@emoji-mart\/data\/sets\/15\/apple\.json";/);
  assert.match(page, /import emojiMartI18n from "@emoji-mart\/data\/i18n\/zh\.json";/);
  assert.match(page, /import appleEmojiSpritesheet from "emoji-datasource-apple\/img\/apple\/sheets-128\/32\.png";/);
  assert.match(page, /import \{ Picker \} from "emoji-mart";/);
  assert.match(page, /new Picker\(\{[\s\S]*?data: emojiMartData,[\s\S]*?i18n: emojiMartI18n,/);
  assert.match(page, /getSpritesheetURL: \(\) => appleEmojiSpritesheet,/);
  assert.match(page, /set: "apple"/);
  assert.match(page, /selectionPendingRef\.current = true;/);
  assert.match(page, /window\.setTimeout\(\(\) => \{/);
  assert.match(page, /categories: mode === "search" \? \[\] : EMOJI_COLLECTION_CATEGORIES,/);
  assert.match(page, /searchPosition: mode === "search" \? "static" : "none",/);
  assert.match(page, /aria-label="搜索表情"/);
  assert.match(page, /aria-label="全部表情"/);
  assert.match(page, /aria-label="收藏表情包"/);
  assert.match(page, /aria-label="添加收藏表情包"/);
  assert.match(page, /支持 PNG、JPG、WebP、GIF；发送时会标记为表情包。/);
  assert.match(page, /<ConversationEmojiPicker actions=\{actions\} \/>/);
  assert.doesNotMatch(page, /COMMON_EMOJI/);
  assert.match(styles, /\.conversation-emoji-panel \{[\s\S]*?width: min\(410px, calc\(100vw - 48px\)\);/);
  assert.match(styles, /\.conversation-emoji-picker__tabs \{[\s\S]*?grid-template-columns: repeat\(3, 1fr\);/);
  assert.match(styles, /\.conversation-sticker-favorites__grid \{[\s\S]*?overflow: auto;/);
  assert.match(packageJson, /"emoji-mart": "\^5\.6\.0"/);
  assert.match(packageJson, /"emoji-datasource-apple": "\^15\.0\.1"/);
});
