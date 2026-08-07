import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ComputerCameraError, launchComputerCamera, parseComputerCameraArgs, runComputerCameraCli } from "../src/index.mjs";

async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-computer-camera-")); }

test("thin computer-camera entry accepts camera timing flags", () => {
  assert.deepEqual(parseComputerCameraArgs(["--camera-index", "2", "--active-seconds", "10", "--warmup-seconds", "0.8", "--data-root", "D:/data"]), { cameraIndex: "2", activeSeconds: "10", warmupSeconds: "0.8", dataRoot: "D:/data" });
  assert.throws(() => parseComputerCameraArgs(["--output", "x"]), ComputerCameraError);
});

test("launcher returns captured or started without waiting for the detached worker to close", async () => {
  const dataRoot = await temporary(); const calls = [];
  const result = await launchComputerCamera({
    dataRoot,
    cameraIndex: 3,
    activeSeconds: 12,
    warmupSeconds: 1.2,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    spawnImpl: (command, args) => { calls.push({ command, args }); return { once() {} }; },
    readStatus: async () => ({ status: "captured" }),
    exists: () => true,
    launchWaitMs: 1,
  });
  assert.equal(result.status, "captured"); assert.equal(result.background, true); assert.equal(result.cameraActiveSeconds, 12); assert.match(result.outputPath, /capabilities[\\/]computer-camera[\\/]captures/u); assert.match(result.statusPath, /capabilities[\\/]computer-camera[\\/]runtime/u);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args.slice(-10), ["--output", result.outputPath, "--status-file", result.statusPath, "--camera-index", "3", "--active-seconds", "12", "--warmup-seconds", "1.2"]);
  const started = await launchComputerCamera({ dataRoot, spawnImpl: () => ({ once() {} }), readStatus: async () => null, exists: () => false, launchWaitMs: 0 });
  assert.equal(started.status, "started");
});

test("launcher exposes worker JSON errors and the CLI keeps the data root software-owned", async () => {
  const dataRoot = await temporary();
  const failed = await launchComputerCamera({ dataRoot, spawnImpl: () => ({ once() {} }), readStatus: async () => ({ status: "error", error: "缺少 opencv-python" }), launchWaitMs: 1 });
  assert.deepEqual(failed.status, "error"); assert.match(failed.error, /opencv/u);
  let invocation;
  const result = await runComputerCameraCli(["--camera-index", "1"], { environment: { SUZU_LIVES_DATA_ROOT: dataRoot }, launch: async (value) => { invocation = value; return { status: "started" }; } });
  assert.equal(result.status, "started"); assert.equal(invocation.dataRoot, path.resolve(dataRoot)); assert.equal(invocation.cameraIndex, "1");
});
