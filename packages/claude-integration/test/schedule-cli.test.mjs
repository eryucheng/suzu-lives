import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSuzuLivesCli } from "../bin/suzu-lives.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runCli(args) {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => {
    output += String(value);
    return true;
  };
  try {
    await runSuzuLivesCli({ args });
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output);
}

test("stable CLI exposes the unified schedule add, list, and remove commands", async () => {
  const dataRoot = await temporaryDirectory("suzu-schedule-stable-cli-");
  const added = await runCli([
    "schedule", "add", "--data-root", dataRoot, "--delay", "10m", "--contact-id", "contact-fixture",
    "--prompt", "稍后自然回访", "--desc", "临时回访",
  ]);
  assert.equal(added.status, "ok");
  assert.equal(added.task.kind, "once");

  const listed = await runCli(["schedule", "list", "--data-root", dataRoot]);
  assert.deepEqual(listed.tasks.map((task) => task.id), [added.task.id]);

  const removed = await runCli(["schedule", "remove", added.task.id, "--data-root", dataRoot]);
  assert.equal(removed.removed, true);
});
