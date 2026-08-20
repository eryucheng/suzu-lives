import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { resolveMailBridgePaths } from "@suzu-lives/mail-bridge";
import { createMailFeedbackLinkService } from "../electron/services/mail-feedback-link.mjs";

async function temporaryDirectory(prefix) {
  const root = process.env.SUZU_LIVES_TEST_TEMP || os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix));
}

async function waitFor(predicate, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("等待邮件投递超时");
}

class FakeReceiver extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.input = "";
    this.killed = false;
    this.stdin.on("data", (chunk) => { this.input += chunk.toString("utf8"); });
  }

  emitEvent(value) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill() {
    this.killed = true;
    return true;
  }
}

test("mail receiver uses a local event stream and delivers one message to every selected session", async () => {
  const root = await temporaryDirectory("suzu-mail-feedback-");
  const dataRoot = path.join(root, "data");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true })]);
  const paths = resolveMailBridgePaths({ projectRoot: projectA, dataRoot });
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.mkdir(paths.inboxPath, { recursive: true });
  await fs.writeFile(paths.configPath, "{}", "utf8");
  const imagePath = path.join(paths.inboxPath, "mail-photo.png");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const child = new FakeReceiver();
  const spawned = [];
  const deliveries = [];
  const service = createMailFeedbackLinkService({
    chat: { sendToSession: async (value) => { deliveries.push(value); } },
    settingsProvider: () => ({ projectRoot: projectA, dataRoot }),
    configuredTargets: () => [
      { sessionId: "session-a", projectRoot: projectA },
      { sessionId: "session-b", projectRoot: projectB },
    ],
    pythonCommand: () => "python-fixture",
    receiverPath: "receiver-fixture.py",
    spawnImpl(command, args, options) {
      spawned.push({ command, args, options });
      return child;
    },
  });

  const started = await service.start();
  assert.equal(started.started, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "python-fixture");
  assert.ok(spawned[0].args.includes("--watch"));
  assert.ok(spawned[0].args.includes("--event-stream"));
  assert.equal(spawned[0].options.stdio.join(","), "pipe,pipe,pipe");
  assert.doesNotMatch(JSON.stringify(spawned[0]), /webhook/iu);
  assert.ok(spawned[0].options.env.SUZU_LIVES_MAIL_INBOX_DIR.startsWith(dataRoot));

  child.emitEvent({
    type: "mail-feedback",
    uid: 17,
    prompt: "邮件发来的照片",
    attachments: [{ kind: "image", path: imagePath, fileName: "mail-photo.png", mimeType: "image/png" }],
  });
  await waitFor(() => deliveries.length === 2 && child.input.includes("\"accepted\":true"));

  assert.deepEqual(deliveries.map((delivery) => [delivery.sessionId, delivery.projectRoot]), [
    ["session-a", projectA],
    ["session-b", projectB],
  ]);
  assert.ok(deliveries.every((delivery) => delivery.kind === "mail-feedback" && delivery.mediaSource === "mail"));
  assert.ok(deliveries.every((delivery) => delivery.hasTranscript === true));
  assert.equal(deliveries[0].media[0].fileName, "mail-photo.png");
  assert.deepEqual(JSON.parse(child.input.trim()), { type: "ack", uid: 17, accepted: true, message: "" });
  service.dispose();
  assert.equal(child.killed, true);
});
