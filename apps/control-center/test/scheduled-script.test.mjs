import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runScheduledScript,
  scheduledScriptCommand,
  validateScheduledScriptPath,
} from "../electron/services/scheduled-script.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

test("scheduled scripts accept only the explicitly supported extensions", async () => {
  const root = await temporaryDirectory("suzu-scheduled-script-");
  const pythonPath = path.join(root, "job.py");
  const commandPath = path.join(root, "job.cmd");
  const unsupportedPath = path.join(root, "job.ps1");
  await Promise.all([
    fs.writeFile(pythonPath, "print('ok')\n"),
    fs.writeFile(commandPath, "@echo ok\r\n"),
    fs.writeFile(unsupportedPath, "Write-Output ok\n"),
  ]);

  assert.equal((await validateScheduledScriptPath(pythonPath)).scriptPath, await fs.realpath(pythonPath));
  assert.equal((await validateScheduledScriptPath(commandPath)).extension, ".cmd");
  await assert.rejects(validateScheduledScriptPath(unsupportedPath), /只支持/u);
});

test("scheduled scripts use Python or cmd.exe without a shell command string", async () => {
  const root = await temporaryDirectory("suzu-scheduled-command-");
  const pythonPath = path.join(root, "daily.py");
  const commandPath = path.join(root, "daily.cmd");
  await fs.writeFile(pythonPath, "print('ok')\n");
  await fs.writeFile(commandPath, "@echo ok\r\n");
  const invocation = scheduledScriptCommand(pythonPath, { pythonCommand: () => "python-test" });
  assert.deepEqual(invocation, { command: "python-test", args: [path.resolve(pythonPath)] });
  assert.deepEqual(scheduledScriptCommand(commandPath), {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", path.resolve(commandPath)],
  });

  const spawned = [];
  const resolvedPythonPath = await fs.realpath(pythonPath);
  const result = await runScheduledScript(pythonPath, {
    pythonCommand: () => "python-test",
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "done");
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(result.stdout, "done");
  assert.deepEqual(spawned, [{
    command: "python-test",
    args: [resolvedPythonPath],
    options: {
      cwd: path.dirname(resolvedPythonPath),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  }]);
});

test("a selected cmd script runs from its own directory", async () => {
  const root = await temporaryDirectory("suzu-scheduled-cmd-run-");
  const commandPath = path.join(root, "daily.cmd");
  await fs.writeFile(commandPath, "@echo scheduled-output\r\n");
  const result = await runScheduledScript(commandPath);
  assert.match(result.stdout, /scheduled-output/u);
  assert.equal(result.scriptPath, await fs.realpath(commandPath));
});
