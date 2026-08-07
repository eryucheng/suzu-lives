import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableAgentId } from "@suzu-lives/agent-registry";
import { runSuzuLivesCli } from "../bin/suzu-lives.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("conversation attachments are copied into the local cache for their Claude session", async () => {
  const root = await temporaryDirectory("suzu-conversation-attachment-");
  const source = path.join(root, "agent-report.txt");
  const dataRoot = path.join(root, "suzu-data");
  const projectRoot = path.join(root, "agent-project");
  await fs.writeFile(source, "附件内容", "utf8");
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => {
    output += String(value);
    return true;
  };
  try {
    await runSuzuLivesCli({
      args: ["conversation-attachment", "--data-root", dataRoot, "--project-root", projectRoot, "--session-id", "session-1", "--file", source],
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const receipt = JSON.parse(output);
  const cached = receipt.items[0];
  assert.equal(cached.fileName, "agent-report.txt");
  assert.notEqual(cached.path, source);
  assert.equal(path.dirname(cached.path), path.join(dataRoot, "agents", stableAgentId(projectRoot), "conversations", "session-1", "attachments"));
  assert.equal(await fs.readFile(cached.path, "utf8"), "附件内容");
});

test("MP3 conversation attachments retain the audio kind in the session cache receipt", async () => {
  const root = await temporaryDirectory("suzu-conversation-audio-");
  const source = path.join(root, "voice.mp3");
  const dataRoot = path.join(root, "suzu-data");
  const projectRoot = path.join(root, "agent-project");
  await fs.writeFile(source, "mp3 内容", "utf8");
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => {
    output += String(value);
    return true;
  };
  try {
    await runSuzuLivesCli({
      args: ["conversation-attachment", "--data-root", dataRoot, "--project-root", projectRoot, "--session-id", "session-audio", "--audio", source],
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const receipt = JSON.parse(output);
  assert.equal(receipt.items[0].kind, "audio");
  assert.equal(receipt.items[0].fileName, "voice.mp3");
  assert.match(receipt.items[0].path, new RegExp(`agents[\\\\/]${stableAgentId(projectRoot)}[\\\\/]conversations[\\\\/]session-audio[\\\\/]attachments`, "u"));
});
