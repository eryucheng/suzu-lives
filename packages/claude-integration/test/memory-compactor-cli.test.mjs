import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../bin/suzu-lives.mjs");

test("stable memory-compact CLI dry-runs the explicit selected session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-memory-cli-root-"));
  const projectRoot = path.join(root, "project");
  const dataRoot = path.join(root, "software-data");
  const transcript = path.join(root, "session.jsonl");
  await fs.mkdir(projectRoot, { recursive: true });
  const records = [
    { uuid: "u1", sessionId: "s", type: "user", message: { role: "user", content: "较早对话" }, timestamp: "2026-07-01T00:00:00.000Z" },
    { uuid: "a1", parentUuid: "u1", sessionId: "s", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "较早回答" }], usage: { input_tokens: 12000 } }, timestamp: "2026-07-01T00:01:00.000Z" },
    { uuid: "u2", parentUuid: "a1", sessionId: "s", type: "user", message: { role: "user", content: "最近对话" }, timestamp: "2026-07-30T01:00:00.000Z" },
    { uuid: "a2", parentUuid: "u2", sessionId: "s", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "最近回答" }], usage: { input_tokens: 20000 } }, timestamp: "2026-07-30T01:01:00.000Z" },
  ];
  await fs.writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const { stdout } = await execFileAsync(process.execPath, [
    cli, "memory-compact", "--dry-run", "--project-root", projectRoot,
    "--transcript", transcript, "--data-root", dataRoot,
    "--now", "2026-07-30T02:00:00.000Z",
  ], { cwd: projectRoot, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "dry-run");
  assert.equal(result.transcriptPath, transcript);
  assert.equal(result.transcriptSource, "explicit");
});
