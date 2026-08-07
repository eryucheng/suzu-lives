import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveIphoneBridgePaths, runIphoneBridgeCli } from "../src/index.mjs";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRuntimeConfig(paths) {
  fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
  fs.writeFileSync(paths.configPath, "{\"fixture\":true}");
}

function createFileLinkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建用于路径安全测试的文件符号链接。 "); return false; }
    throw error;
  }
}

test("iPhone paths keep config, state and inbox in software data", () => {
  const projectRoot = temporaryDirectory("suzu-iphone-project-");
  const dataRoot = temporaryDirectory("suzu-iphone-data-");
  const paths = resolveIphoneBridgePaths({ projectRoot, dataRoot });
  assert.ok(paths.configPath.startsWith(paths.runtimeRoot));
  assert.ok(paths.runtimeRoot.startsWith(dataRoot));
  assert.ok(paths.statePath.startsWith(paths.runtimeRoot));
  assert.ok(paths.inboxPath.startsWith(paths.runtimeRoot));
  assert.equal(paths.sendScriptPath.includes("suzu-lives-private"), false);
  assert.equal(paths.receiveScriptPath.includes("suzu-lives-private"), false);
});

test("runtime rejects a software config replaced by a symbolic link", async (t) => {
  const projectRoot = temporaryDirectory("suzu-iphone-runtime-project-");
  const dataRoot = temporaryDirectory("suzu-iphone-runtime-data-");
  const paths = resolveIphoneBridgePaths({ projectRoot, dataRoot });
  writeRuntimeConfig(paths);
  fs.unlinkSync(paths.configPath);
  const outside = path.join(temporaryDirectory("suzu-iphone-runtime-source-"), "feedback_config.json");
  fs.writeFileSync(outside, "{\"outside\":true}");
  if (!createFileLinkOrSkip(t, outside, paths.configPath)) return;
  let spawned = false;
  assert.throws(() => runIphoneBridgeCli({
    args: ["send", "主题", "内容", "--project-root", projectRoot, "--data-root", dataRoot], env: {},
    stdout: { write() {} }, stderr: { write() {} }, spawnProcess() { spawned = true; return { status: 0 }; },
  }), /符号链接|Windows junction/u);
  assert.equal(spawned, false);
});

test("send preserves the SMTP request shape through the owned script", async () => {
  const projectRoot = temporaryDirectory("suzu-iphone-project-");
  const dataRoot = temporaryDirectory("suzu-iphone-data-");
  const paths = resolveIphoneBridgePaths({ projectRoot, dataRoot }); writeRuntimeConfig(paths); let called;
  const result = runIphoneBridgeCli({
    args: ["send", "闹钟", "08:30 起床", "--project-root", projectRoot, "--data-root", dataRoot],
    env: {},
    stdout: { write() {} },
    stderr: { write() {} },
    spawnProcess(command, args, options) {
      called = { command, args, options };
      return { status: 0, stdout: "已发送\n", stderr: "" };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(called.command, "python");
  assert.equal(called.args[1], "闹钟");
  assert.equal(called.args[2], "08:30 起床");
  assert.equal(called.args.at(-2), "--config");
  assert.equal(called.args.at(-1), result.paths.configPath);
  assert.ok(called.options.env.SUZU_LIVES_IPHONE_INBOX_DIR.startsWith(dataRoot));
});

test("receive only previews a mapping; the Suzu app owns the feedback listener", async () => {
  const projectRoot = temporaryDirectory("suzu-iphone-project-");
  const dataRoot = temporaryDirectory("suzu-iphone-data-");
  const paths = resolveIphoneBridgePaths({ projectRoot, dataRoot }); writeRuntimeConfig(paths); let called;
  assert.throws(() => runIphoneBridgeCli({
    args: ["receive", "--once", "--project-root", projectRoot, "--data-root", dataRoot],
    env: {}, stdout: { write() {} }, stderr: { write() {} },
    spawnProcess() { throw new Error("the app must own the listener"); },
  }), /Suzu 软件管理/u);
  const result = runIphoneBridgeCli({
    args: ["receive", "--preview", "查岗", "", "--project-root", projectRoot, "--data-root", dataRoot],
    env: {},
    stdout: { write() {} },
    stderr: { write() {} },
    spawnProcess(command, args, options) {
      called = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(called.args.slice(1, 7), [
    "--config", result.paths.configPath,
    "--state", result.paths.statePath, "--preview", "查岗",
  ]);
  assert.ok(result.paths.statePath.startsWith(dataRoot));
});
