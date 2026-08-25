import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

test("composer keeps only working emoji, unified attachment, and voice-input controls", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");
  const documentHtml = readFileSync(resolve(HERE, "..", "src", "index.html"), "utf8");
  const voiceInput = readFileSync(resolve(HERE, "..", "src", "react", "conversation-voice-input.jsx"), "utf8");
  const conversation = readFileSync(resolve(HERE, "..", "src", "features", "conversation", "index.mjs"), "utf8");

  assert.match(page, /aria-label="表情"/u);
  assert.match(page, /aria-label="添加文件"[\s\S]*?selectComposerAttachments\("file"\)/u);
  assert.match(page, /function clipboardImageFiles\(clipboardData\)/u);
  assert.match(page, /onPaste=\{\(event\) => \{[\s\S]*?clipboardImageFiles\(event\.clipboardData\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?actions\.pasteComposerImages\(images\)/u);
  assert.match(page, /const imagePreviewUrl = attachment\.kind === "image" \? String\(attachment\.fileUrl \|\| ""\) : "";/u);
  assert.match(page, /conversation-composer__attachment\$\{imagePreviewUrl \? " is-image" : ""\}/u);
  assert.match(page, /<img alt=\{`图片预览：\$\{attachment\.fileName\}`\} src=\{imagePreviewUrl\} \/>/u);
  assert.match(documentHtml, /img-src 'self' blob: data: file:/u);
  assert.match(styles, /conversation-composer__attachment\.is-image\s*\{[\s\S]*?width: 78px;[\s\S]*?height: 60px;/u);
  assert.match(styles, /conversation-composer__attachment\.is-image > img\s*\{[\s\S]*?width: 100%;[\s\S]*?height: 100%;/u);
  assert.match(page, /conversation-send-button" disabled=\{unavailable \|\| sending \|\| composer\.attachmentPicking\}/u);
  assert.match(page, /aria-label=\{voiceInput\?\.label \|\| "语音输入"\}/u);
  assert.match(page, /conversation-composer__tool--voice-input/u);
  assert.match(styles, /conversation-composer__tool--voice-input\.is-active/u);
  assert.match(voiceInput, /正在录音，点击结束并识别/u);
  assert.doesNotMatch(voiceInput, /VOICE_SILENCE_FRAME_COUNT|void finishRecording\(\{ commit: true \}\);/u);
  assert.doesNotMatch(page, /添加图片|StaticTool|name === "box"|name === "scissors"|name === "sound"/u);
  assert.doesNotMatch(styles, /conversation-composer__static-tool/u);
  assert.match(styles, /--conversation-composer-placeholder-color/u);
  assert.match(styles, /textarea::placeholder[\s\S]*?color: var\(--conversation-composer-placeholder-color\)/u);
  assert.match(styles, /conversation-composer__command-hints[\s\S]*?top: 42px[\s\S]*?color: var\(--conversation-composer-placeholder-color\)/u);
  assert.match(page, /const draftHasAppleEmoji = textGraphemes\(draft\)\.some\(\(segment\) => APPLE_EMOJI_BY_NATIVE\.has\(segment\)\);/u);
  assert.match(page, /conversation-composer__input-layer[\s\S]*?conversation-composer__draft-mirror/u);
  assert.match(page, /onScroll=\{\(event\) => syncDraftMirrorScroll\(event\.currentTarget\)\}/u);
  assert.match(styles, /conversation-composer__input-layer\.has-emoji-mirror > textarea[\s\S]*?color: transparent;[\s\S]*?caret-color:/u);
  assert.match(styles, /conversation-composer__draft-mirror \{[\s\S]*?pointer-events: none;/u);
  assert.match(page, /const externalDraft = String\(composer\.draft \|\| ""\);[\s\S]*?const \[draft, setDraft\] = useState\(\(\) => externalDraft\);/u);
  assert.match(page, /setDraft\(nextDraft\);[\s\S]*?actions\.setDraft\(nextDraft\);/u);
  assert.match(page, /const submitMessage = \(\) => \{[\s\S]*?if \(unavailable \|\| sending \|\| composer\.attachmentPicking \|\| \(!draft\.trim\(\) && !attachments\.length\)\) return;[\s\S]*?setDraft\(""\);[\s\S]*?actions\.submitMessage\(\);[\s\S]*?\};/u);
  assert.match(page, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); submitMessage\(\); \}\}/u);
  assert.match(page, /shouldSubmitConversationOnEnter\(event\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?submitMessage\(\);/u);
  assert.match(page, /const handledFocusRequestRef = useRef\(0\);/u);
  assert.match(page, /if \(focusRequest === handledFocusRequestRef\.current \|\| unavailable \|\| inputRef\.current\?\.disabled\) return;[\s\S]*?inputRef\.current\?\.focus\(\);[\s\S]*?handledFocusRequestRef\.current = focusRequest;/u);
  assert.match(page, /!draft && !attachments\.length/u);
  assert.match(page, /row\.entering && "is-entering"/u);
  assert.match(page, /const key = row\.type === "message"/u);
  assert.match(styles, /@keyframes conversation-message-in/u);
  assert.match(styles, /\.content--conversation \.conversation-message\.is-entering\s*\{[\s\S]*?animation: conversation-message-in/u);

  const setDraftStart = conversation.indexOf("setDraft: (value) => {");
  const setDraftEnd = conversation.indexOf("setListScroll:", setDraftStart);
  assert.ok(setDraftStart >= 0 && setDraftEnd > setDraftStart);
  assert.doesNotMatch(conversation.slice(setDraftStart, setDraftEnd), /context\.render\(\)/u);

  const sendMessageStart = conversation.indexOf("async function sendMessage(context) {");
  const sendMessageEnd = conversation.indexOf("async function saveCurrentContactAvatar", sendMessageStart);
  assert.ok(sendMessageStart >= 0 && sendMessageEnd > sendMessageStart);
  assert.match(
    conversation.slice(sendMessageStart, sendMessageEnd),
    /viewState\.pending\.push\(pending\);[\s\S]*?scheduleScrollToLatest\(\);[\s\S]*?focusComposer\(\);[\s\S]*?context\.render\(\);/u,
  );
  assert.match(conversation, /sending: viewState\.sending,[\s\S]*?unavailable: !ready \|\| !activeContact,/u);
  assert.match(conversation, /viewState\.pending = viewState\.pending\.filter\(\(item\) => item !== pending\);[\s\S]*?if \(!viewState\.draft\) viewState\.draft = raw;/u);
});

test("composer height can be adjusted within a bounded range without covering the message list", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");
  const conversation = readFileSync(resolve(HERE, "..", "src", "features", "conversation", "index.mjs"), "utf8");

  assert.match(page, /CONVERSATION_COMPOSER_MIN_HEIGHT = 168/u);
  assert.match(page, /CONVERSATION_COMPOSER_MAX_HEIGHT = 420/u);
  assert.match(page, /className="conversation-composer-resizer"/u);
  assert.match(page, /onPointerDown=\{onResizePointerDown\}/u);
  assert.match(page, /onPointerMove=\{onResizePointerMove\}/u);
  assert.match(page, /onResizePointerDown=\{beginComposerResize\}/u);
  assert.match(page, /onResizePointerMove=\{resizeComposer\}/u);
  assert.match(styles, /--conversation-composer-height: 168px;/u);
  assert.match(styles, /\.conversation-composer-resizer\s*\{[\s\S]*?cursor: row-resize;/u);
  assert.match(styles, /\.content--conversation \.conversation-composer \{[\s\S]*?--conversation-composer-inline-padding: clamp\(10px, 1\.25vw, 18px\);[\s\S]*?height: var\(--conversation-composer-height\);[\s\S]*?padding: 10px var\(--conversation-composer-inline-padding\);/u);
  assert.match(styles, /\.conversation-latest \{[\s\S]*?bottom: calc\(var\(--conversation-composer-height\) \+ 4px\);/u);
  assert.match(conversation, /composerHeight: context\.state\.settings\?\.conversationComposerHeight/u);
  assert.match(conversation, /setConversationComposerHeight: async/u);
});

test("conversation bubbles keep a fixed desktop reading width and only shrink in a narrow message row", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");

  assert.match(styles, /\.content--conversation \.conversation-bubble\s*\{[\s\S]*?width: fit-content;[\s\S]*?max-width: min\(680px, calc\(100% - 48px\)\);/u);
  assert.match(styles, /\.content--conversation \.conversation-message\.system \.conversation-bubble,[\s\S]*?max-width: min\(880px, 100%\);/u);
  assert.doesNotMatch(styles, /\.content--conversation \.conversation-bubble\s*\{[\s\S]*?max-width: min\(64%, 680px\);/u);
});
