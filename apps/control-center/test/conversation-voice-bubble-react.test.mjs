import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

test("voice messages match the avatar height and mirror their waves toward the recipient", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.css"), "utf8");
  const conversationStyles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");
  const conversationModel = readFileSync(resolve(HERE, "..", "src", "features", "conversation", "index.mjs"), "utf8");

  assert.match(page, /function ConversationVoiceWaves\(\{ mirrored = false \}\)/u);
  assert.match(page, /const bubbleWidth = Math\.min\(180, Math\.max\(112, 92 \+ Math\.ceil\(duration\) \* 1\.7\)\);/u);
  assert.match(page, /className=\{\[\s*"conversation-audio__button",[\s\S]*?ownMessage \? "is-outgoing" : "is-incoming"/u);
  assert.match(page, /onClick=\{\(\) => \{ void togglePlayback\(!playing\); \}\}/u);
  assert.match(page, /ownMessage=\{row\.kind === "user"\}/u);
  assert.match(page, /row\.audioOnly && "is-audio-only"/u);
  assert.match(conversationModel, /const audioOnly = blocks\.length === 1 && blocks\[0\]\?\.type === "audio";/u);
  assert.match(page, /<ConversationVoiceWaves mirrored=\{ownMessage\} \/>/u);
  assert.doesNotMatch(page, /<ChatVoice\b/u);
  assert.match(styles, /height:var\(--conversation-message-avatar-size, 31px\);/u);
  assert.match(styles, /conversation-message\.is-audio-only \.conversation-audio\s*\{[\s\S]*?transform:translateY\(2px\);/u);
  assert.match(styles, /justify-content:flex-end;/u);
  assert.match(styles, /min-width:112px;/u);
  assert.match(styles, /font-size:13px;/u);
  assert.match(styles, /conversation-audio__button\.is-incoming\s*\{[\s\S]*?flex-direction:row-reverse;/u);
  assert.match(styles, /conversation-audio__waves\.is-mirrored/u);
  assert.doesNotMatch(styles, /conversation-audio__button::after/u);
  assert.match(conversationStyles, /\.conversation-message\s*\{[\s\S]*?--conversation-message-avatar-size: 31px;/u);
  assert.match(conversationStyles, /\.conversation-avatar\s*\{[\s\S]*?width: var\(--conversation-message-avatar-size\);[\s\S]*?height: var\(--conversation-message-avatar-size\);/u);
  assert.match(conversationStyles, /\.conversation-message\.is-audio-only\s*\{[\s\S]*?align-items: center;/u);
});
