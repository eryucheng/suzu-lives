import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { resolveIphoneBridgePaths } from "@suzu-lives/iphone-bridge";
import { createIphoneFeedbackLinkService } from "../electron/services/iphone-feedback-link.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("等待 iPhone 反馈投递超时");
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

test("iPhone receiver uses a local event stream and delivers one feedback to every selected session", async () => {
  const root = await temporaryDirectory("suzu-iphone-feedback-");
  const dataRoot = path.join(root, "data");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true })]);
  const paths = resolveIphoneBridgePaths({ projectRoot: projectA, dataRoot });
  await fs.mkdir(path.dirname(paths.configPath), { recursive: true });
  await fs.mkdir(paths.inboxPath, { recursive: true });
  await fs.writeFile(paths.configPath, "{}", "utf8");
  const imagePath = path.join(paths.inboxPath, "phone-photo.png");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const child = new FakeReceiver();
  const spawned = [];
  const deliveries = [];
  const service = createIphoneFeedbackLinkService({
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

  child.emitEvent({
    type: "iphone-feedback",
    uid: 17,
    prompt: "手机发来的照片",
    attachments: [{ kind: "image", path: imagePath, fileName: "phone-photo.png", mimeType: "image/png" }],
  });
  await waitFor(() => deliveries.length === 2 && child.input.includes("\"accepted\":true"));

  assert.deepEqual(deliveries.map((delivery) => [delivery.sessionId, delivery.projectRoot]), [
    ["session-a", projectA],
    ["session-b", projectB],
  ]);
  assert.ok(deliveries.every((delivery) => delivery.kind === "iphone-feedback" && delivery.mediaSource === "iphone"));
  assert.ok(deliveries.every((delivery) => delivery.hasTranscript === true));
  assert.equal(deliveries[0].media[0].fileName, "phone-photo.png");
  assert.deepEqual(JSON.parse(child.input.trim()), { type: "ack", uid: 17, accepted: true, message: "" });
  service.dispose();
  assert.equal(child.killed, true);
});
