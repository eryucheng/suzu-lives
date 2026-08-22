import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ConversationAttachmentError,
  createConversationAttachmentService,
} from "../electron/services/conversation-attachment-service.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=",
  "base64",
);

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-dsh-attachment-"));
}

test("conversation attachment service caches files per DSH session and builds native image input", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  const report = path.join(root, "report.txt");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, ONE_PIXEL_PNG);
  await fs.writeFile(report, "这是一份普通文件。", "utf8");

  const service = createConversationAttachmentService({ dataRoot });
  const prepared = await service.prepare({
    content: "帮我看看图片，也读一下文件。",
    media: [
      { kind: "image", path: image },
      { kind: "file", path: report },
    ],
    projectRoot,
    sessionId: "contact-session",
  });

  assert.equal(prepared.media.length, 2);
  assert.deepEqual(prepared.media.map((item) => item.kind), ["image", "file"]);
  assert.ok(prepared.media.every((item) => item.filePath.startsWith(path.join(dataRoot, "agents"))));
  assert.ok(prepared.media.every((item) => item.fileUrl.startsWith("file:")));
  assert.equal(await fs.readFile(prepared.media[0].filePath).then((data) => data.equals(ONE_PIXEL_PNG)), true);
  assert.equal(await fs.readFile(prepared.media[1].filePath, "utf8"), "这是一份普通文件。");
  assert.deepEqual(prepared.input.map((part) => part.type), ["text", "text", "image"]);
  assert.equal(prepared.input[0].text, "帮我看看图片，也读一下文件。");
  assert.match(prepared.input[1].text, /<conversation-media>/u);
  assert.match(prepared.input[1].text, /"fileName":"report\.txt"/u);
  assert.equal(prepared.input[2].mediaType, "image/png");
  assert.equal(Buffer.from(prepared.input[2].data, "base64").equals(ONE_PIXEL_PNG), true);
});

test("conversation attachment service recognizes images selected through the unified file picker", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const image = path.join(root, "reference.png");
  const report = path.join(root, "report.txt");
  await fs.writeFile(image, ONE_PIXEL_PNG);
  await fs.writeFile(report, "这是一份普通文件。", "utf8");

  const service = createConversationAttachmentService({ dataRoot });
  const [recognizedImage, recognizedFile] = await Promise.all([
    service.inspect({ kind: "auto", path: image }),
    service.inspect({ kind: "auto", path: report }),
  ]);

  assert.equal(recognizedImage.kind, "image");
  assert.equal(recognizedFile.kind, "file");
});

test("conversation attachment service accepts a pasted image binary through the normal durable attachment path", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });

  const prepared = await createConversationAttachmentService({ dataRoot }).prepare({
    media: [{
      data: new Uint8Array(ONE_PIXEL_PNG),
      fileName: "clipboard-image.png",
      kind: "image",
      mimeType: "image/png",
    }],
    projectRoot,
    sessionId: "contact-session",
  });

  assert.equal(prepared.media.length, 1);
  assert.equal(prepared.media[0].kind, "image");
  assert.equal(await fs.readFile(prepared.media[0].filePath).then((data) => data.equals(ONE_PIXEL_PNG)), true);
  assert.equal(Buffer.from(prepared.input.at(-1).data, "base64").equals(ONE_PIXEL_PNG), true);
});

test("conversation attachment service keeps media cards while preparing image and video for the existing understanding capabilities", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  const video = path.join(root, "moment.mp4");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, ONE_PIXEL_PNG);
  await fs.writeFile(video, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));

  const prepared = await createConversationAttachmentService({ dataRoot }).prepare({
    content: "看看这些媒体",
    includeNativeImages: false,
    media: [
      { kind: "image", path: image },
      { kind: "file", path: video },
    ],
    projectRoot,
    sessionId: "contact-session",
  });

  assert.deepEqual(prepared.media.map((item) => item.kind), ["image", "file"]);
  assert.equal(prepared.media[1].mimeType, "video/mp4");
  assert.deepEqual(prepared.understandingMedia.map((item) => item.kind), ["image", "video"]);
  assert.deepEqual(prepared.input.map((part) => part.type), ["text", "text"]);
  assert.match(prepared.input[1].text, /已启用的图像理解能力/u);
});

test("conversation attachment service keeps unsupported images as local files instead of sending invalid DSH image parts", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const source = path.join(root, "legacy.bmp");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(source, Buffer.from([0x42, 0x4d, 0x00, 0x00]));

  const prepared = await createConversationAttachmentService({ dataRoot }).prepare({
    media: [{ kind: "image", path: source, mimeType: "image/bmp" }],
    projectRoot,
    sessionId: "contact-session",
  });

  assert.deepEqual(prepared.media.map((item) => item.kind), ["file"]);
  assert.deepEqual(prepared.input.map((part) => part.type), ["text"]);
});

test("conversation attachment service rejects non-regular attachment sources", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  await assert.rejects(
    createConversationAttachmentService({ dataRoot }).prepare({
      media: [{ kind: "file", path: projectRoot }],
      projectRoot,
      sessionId: "contact-session",
    }),
    (error) => error instanceof ConversationAttachmentError && error.code === "ATTACHMENT_NOT_REGULAR_FILE",
  );
});

test("conversation attachment service delivers Agent-created media through the durable receipt", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "generated.png");
  const audio = path.join(root, "voice.mp3");
  const report = path.join(root, "report.txt");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, ONE_PIXEL_PNG);
  await fs.writeFile(audio, Buffer.from([0x49, 0x44, 0x33, 0x04]));
  await fs.writeFile(report, "这是 Suzu 生成的报告。", "utf8");

  const receipt = await createConversationAttachmentService({ dataRoot }).deliver({
    input: {
      items: [
        { kind: "image", path: image },
        { kind: "audio", path: audio },
        { kind: "file", path: report },
      ],
    },
    projectRoot,
    sessionId: "contact-session",
  });

  assert.equal(receipt.status, "ok");
  assert.equal(receipt.type, "suzu-conversation-attachment");
  assert.match(receipt.receiptId, /^attachment-/u);
  assert.deepEqual(receipt.items.map((item) => item.kind), ["image", "audio", "file"]);
  assert.ok(receipt.items.every((item) => item.path.startsWith(path.join(dataRoot, "agents"))));
  assert.ok(receipt.items.every((item) => item.path.includes(`${path.sep}attachments${path.sep}`)));
  assert.equal(await fs.readFile(receipt.items[0].path).then((data) => data.equals(ONE_PIXEL_PNG)), true);
  assert.equal(await fs.readFile(receipt.items[1].path).then((data) => data.equals(Buffer.from([0x49, 0x44, 0x33, 0x04]))), true);
  assert.equal(await fs.readFile(receipt.items[2].path, "utf8"), "这是 Suzu 生成的报告。");
  assert.equal(await fs.readFile(report, "utf8"), "这是 Suzu 生成的报告。");
});

test("Agent attachment delivery keeps the wider output-image set and validates the actual source extension", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const svg = path.join(root, "generated.svg");
  const text = path.join(root, "not-an-image.txt");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
  await fs.writeFile(text, "不是图片", "utf8");

  const service = createConversationAttachmentService({ dataRoot });
  const receipt = await service.deliver({
    input: { items: [{ kind: "image", path: svg, fileName: "给你的小图.png" }] },
    projectRoot,
    sessionId: "contact-session",
  });
  assert.equal(receipt.items[0].kind, "image");
  assert.equal(receipt.items[0].mimeType, "image/svg+xml");
  assert.equal(receipt.items[0].fileName, "给你的小图.png");

  await assert.rejects(
    service.deliver({
      input: { items: [{ kind: "image", path: text, fileName: "伪装成图片.png" }] },
      projectRoot,
      sessionId: "contact-session",
    }),
    (error) => error instanceof ConversationAttachmentError && error.code === "AGENT_ATTACHMENT_IMAGE_INVALID",
  );
});
