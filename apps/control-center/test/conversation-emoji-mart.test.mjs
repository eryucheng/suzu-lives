import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PRODUCT_FEATURES } from "../shared/product-features.mjs";

const ROOT = new URL("..", import.meta.url);

test("conversation uses a local Apple Emoji Mart picker with active search and collection tabs", async () => {
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
  assert.match(page, /const APPLE_EMOJI_BY_NATIVE = new Map\(/);
  assert.match(page, /new Intl\.Segmenter\(undefined, \{ granularity: "grapheme" \}\)/);
  assert.match(page, /backgroundImage: `url\(\$\{appleEmojiSpritesheet\}\)`,/);
  assert.match(page, /<ConversationRenderedText onOpenExternal=\{onOpenExternal\} text=\{block\.text\} \/>/);
  assert.match(page, /set: "apple"/);
  assert.match(page, /selectionPendingRef\.current = true;/);
  assert.match(page, /window\.setTimeout\(\(\) => \{/);
  assert.match(page, /categories: mode === "search" \? \[\] : EMOJI_COLLECTION_CATEGORIES,/);
  assert.match(page, /dynamicWidth: true,/);
  assert.doesNotMatch(page, /perLine: 8,/);
  assert.match(page, /searchPosition: mode === "search" \? "static" : "none",/);
  assert.match(page, /aria-label="搜索表情"/);
  assert.match(page, /aria-label="全部表情"/);
  assert.equal(PRODUCT_FEATURES.builtinEmojiStickers, true);
  assert.equal(PRODUCT_FEATURES.customEmojiStickers, true);
  assert.match(page, /PRODUCT_FEATURES\.builtinEmojiStickers \? <button aria-label="内置表情"/);
  assert.match(page, /PRODUCT_FEATURES\.customEmojiStickers \? <button aria-label="收藏表情包"/);
  assert.match(page, /conversation-emoji-picker__tabs is-\$\{2 \+ Number\(PRODUCT_FEATURES\.builtinEmojiStickers\) \+ Number\(PRODUCT_FEATURES\.customEmojiStickers\)\}/);
  assert.match(page, /<ConversationEmojiPicker actions=\{actions\} \/>/);
  assert.doesNotMatch(page, /COMMON_EMOJI/);
  assert.match(styles, /\.conversation-emoji-panel \{[\s\S]*?bottom: 54px;[\s\S]*?left: calc\(var\(--conversation-composer-inline-padding\) \+ 26\.5px\);[\s\S]*?translate: -50% 0;[\s\S]*?width: min\(376px, calc\(100vw - 48px\)\);/);
  assert.match(styles, /\.conversation-pane:has\(\.conversation-emoji-panel\) \{[\s\S]*?overflow: visible;/);
  assert.match(styles, /\.conversation-chat-shell:has\(\.conversation-emoji-panel\) \{[\s\S]*?overflow: visible;/);
  assert.match(styles, /\.conversation-inline-emoji \{[\s\S]*?background-repeat: no-repeat;/);
  assert.match(styles, /\.conversation-emoji-picker__tabs \{[\s\S]*?grid-template-columns: repeat\(4, 1fr\);/);
  assert.match(styles, /\.conversation-emoji-picker__tabs\.is-3 \{[\s\S]*?grid-template-columns: repeat\(3, 1fr\);/);
  assert.match(styles, /\.conversation-emoji-picker__tabs\.is-2 \{[\s\S]*?grid-template-columns: repeat\(2, 1fr\);/);
  assert.match(packageJson, /"emoji-mart": "\^5\.6\.0"/);
  assert.match(packageJson, /"emoji-datasource-apple": "\^15\.0\.1"/);
});
