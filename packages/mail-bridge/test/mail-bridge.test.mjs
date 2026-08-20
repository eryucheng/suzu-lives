import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveMailBridgePaths, runMailBridgeCli, sendMailBridge } from "../src/index.mjs";

function temporaryDirectory(prefix) {
  const root = process.env.SUZU_LIVES_TEST_TEMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
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

test("mail bridge keeps config, state and inbox in software data", () => {
  const projectRoot = temporaryDirectory("suzu-mail-project-");
  const dataRoot = temporaryDirectory("suzu-mail-data-");
  const paths = resolveMailBridgePaths({ projectRoot, dataRoot });
  assert.ok(paths.configPath.startsWith(paths.runtimeRoot));
  assert.ok(paths.runtimeRoot.startsWith(dataRoot));
  assert.ok(paths.statePath.startsWith(paths.runtimeRoot));
  assert.ok(paths.inboxPath.startsWith(paths.runtimeRoot));
  assert.equal(path.basename(path.dirname(paths.sendScriptPath)), "python");
  assert.equal(path.dirname(paths.receiveScriptPath), path.dirname(paths.sendScriptPath));
  assert.equal(path.basename(paths.sendScriptPath), "send_mail.py");
  assert.equal(path.basename(paths.receiveScriptPath), "receive_mail.py");
});

test("runtime rejects a software config replaced by a symbolic link", async (t) => {
  const projectRoot = temporaryDirectory("suzu-mail-runtime-project-");
  const dataRoot = temporaryDirectory("suzu-mail-runtime-data-");
  const paths = resolveMailBridgePaths({ projectRoot, dataRoot });
  writeRuntimeConfig(paths);
  fs.unlinkSync(paths.configPath);
  const outside = path.join(temporaryDirectory("suzu-mail-runtime-source-"), "mail_config.json");
  fs.writeFileSync(outside, "{\"outside\":true}");
  if (!createFileLinkOrSkip(t, outside, paths.configPath)) return;
  let spawned = false;
  assert.throws(() => runMailBridgeCli({
    args: ["send", "主题", "内容", "--project-root", projectRoot, "--data-root", dataRoot], env: {},
    stdout: { write() {} }, stderr: { write() {} }, spawnProcess() { spawned = true; return { status: 0 }; },
  }), /符号链接|Windows junction/u);
  assert.equal(spawned, false);
});

test("send preserves the SMTP request shape through the owned script", () => {
  const projectRoot = temporaryDirectory("suzu-mail-project-");
  const dataRoot = temporaryDirectory("suzu-mail-data-");
  const paths = resolveMailBridgePaths({ projectRoot, dataRoot }); writeRuntimeConfig(paths); let called;
  const result = runMailBridgeCli({
    args: ["send", "提醒", "08:30 起床", "--project-root", projectRoot, "--data-root", dataRoot],
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
  assert.equal(called.args[1], "提醒");
  assert.equal(called.args[2], "08:30 起床");
  assert.equal(called.args.at(-2), "--config");
  assert.equal(called.args.at(-1), result.paths.configPath);
  assert.ok(called.options.env.SUZU_LIVES_MAIL_INBOX_DIR.startsWith(dataRoot));
});

test("DSH can submit a mail request without blocking its own runtime", async () => {
  const projectRoot = temporaryDirectory("suzu-mail-agent-project-");
  const dataRoot = temporaryDirectory("suzu-mail-agent-data-");
  const paths = resolveMailBridgePaths({ projectRoot, dataRoot });
  writeRuntimeConfig(paths);
  let called;
  const result = await sendMailBridge({
    subject: "提醒",
    content: "08:30 起床",
    projectRoot,
    dataRoot,
    env: {},
    spawnProcess(command, args, options) {
      called = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", "已发送\n");
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.deepEqual(result, { status: "sent", subject: "提醒" });
  assert.equal(called.command, "python");
  assert.equal(called.args[1], "提醒");
  assert.equal(called.args[2], "08:30 起床");
  assert.equal(called.args.at(-2), "--config");
  assert.equal(called.args.at(-1), paths.configPath);
  assert.equal(called.options.stdio.join(","), "ignore,pipe,pipe");
  assert.ok(called.options.env.SUZU_LIVES_MAIL_INBOX_DIR.startsWith(dataRoot));
});

test("receive only previews a mapping; the Suzu app owns the mailbox listener", async () => {
  const projectRoot = temporaryDirectory("suzu-mail-project-");
  const dataRoot = temporaryDirectory("suzu-mail-data-");
  const paths = resolveMailBridgePaths({ projectRoot, dataRoot }); writeRuntimeConfig(paths); let called;
  assert.throws(() => runMailBridgeCli({
    args: ["receive", "--once", "--project-root", projectRoot, "--data-root", dataRoot],
    env: {}, stdout: { write() {} }, stderr: { write() {} },
    spawnProcess() { throw new Error("the app must own the listener"); },
  }), /Suzu 软件管理/u);
  const result = runMailBridgeCli({
    args: ["receive", "--preview", "Suzu", "", "--project-root", projectRoot, "--data-root", dataRoot],
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
    "--state", result.paths.statePath, "--preview", "Suzu",
  ]);
  assert.ok(result.paths.statePath.startsWith(dataRoot));
});
