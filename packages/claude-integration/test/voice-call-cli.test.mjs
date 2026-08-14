import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseInternalCapabilityRequest } from "@suzu-lives/capability-registry/internal-cli";
import { renderCapabilitySkill } from "../src/index.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PACKAGE_ROOT, "bin", "suzu-lives.mjs");

function isolatedEnvironment() {
  const environment = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

test("voice-call capability returns a structured in-app incoming-call request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-call-cli-"));
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "contact-project");
  await Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(projectRoot, { recursive: true })]);

  const result = await execFileAsync(process.execPath, [
    CLI,
    "capability", "voice-call", "request",
    "--input-json", JSON.stringify({ reason: "想听听你的声音" }),
    "--data-root", dataRoot,
    "--workspace-root", projectRoot,
  ], {
    cwd: PACKAGE_ROOT,
    env: isolatedEnvironment(),
  });

  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    status: "ok",
    capabilityId: "voice-call",
    action: "request",
    result: {
      type: "suzu-voice-call-request",
      reason: "想听听你的声音",
    },
  });
  const skill = renderCapabilitySkill({ abilityId: "voice-call" });
  assert.match(skill, /capability voice-call request/u);
  assert.match(skill, /用户会先看到来电并决定接听或拒绝/u);
  assert.match(skill, /不会拨打真实电话号码/u);
});

test("voice-call capability accepts only a short optional reason", () => {
  assert.deepEqual(parseInternalCapabilityRequest({
    positional: ["voice-call", "request"],
    options: { "input-json": "{}" },
  }).input, { reason: "" });
  assert.throws(
    () => parseInternalCapabilityRequest({
      positional: ["voice-call", "request"],
      options: { "input-json": JSON.stringify({ reason: "x".repeat(241) }) },
    }),
    /不能超过 240 个字符/u,
  );
});
