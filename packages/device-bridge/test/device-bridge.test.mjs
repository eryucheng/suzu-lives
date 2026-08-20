import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeComputerCameraCapture,
  executeComputerCameraSession,
  planComputerCameraCapture,
} from "../src/index.mjs";
import { CapabilityExecutionError, consumeCapabilityAuthorization, issueCapabilityAuthorization } from "@suzu-lives/capability-runtime";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authorization(root, action, scope) {
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId: "computer-camera", action, scope, now: () => 1_000 });
  return consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "computer-camera", action, scope, now: () => 1_001 });
}

test("camera planning never opens a device or creates a capture directory", () => {
  const root = temporaryDirectory("suzu-device-camera-");
  const plan = planComputerCameraCapture({ dataRoot: root, cameraIndex: 1, requestedBy: "test", operation: "start" });

  assert.equal(plan.status, "requires-device-authorization");
  assert.equal(plan.willOpenCamera, false);
  assert.match(plan.plannedOutputPath, /capabilities[\\/]computer-camera[\\/]captures/u);
  assert.equal(fs.existsSync(path.dirname(plan.plannedOutputPath)), false);
});
test("camera lifecycle rejects a disabled gate before probing or creating a worker", async () => {
  const root = temporaryDirectory("suzu-device-camera-gate-");
  let probed = false;
  let opened = false;
  await assert.rejects(
    () => executeComputerCameraSession({
      dataRoot: root,
      gate: { enabled: false, configured: true },
      configuration: { pythonCommand: "python" },
      authorization: {},
      invocation: { scope: { cameraIndex: 0, operation: "start", warmupSeconds: 0.8 } },
      dependencyProbe: async () => { probed = true; return true; },
      sessionFactory: async () => { opened = true; },
    }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_DISABLED",
  );
  assert.equal(probed, false);
  assert.equal(opened, false);
});

test("camera has a fake-worker prewarm, capture, status, and explicit confirmed close lifecycle", async () => {
  const root = temporaryDirectory("suzu-device-camera-run-");
  const startScope = { cameraIndex: 2, operation: "start", warmupSeconds: 0.2 };
  let closed = false;
  const started = await executeComputerCameraSession({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    configuration: { pythonCommand: "python" },
    cameraIndex: 2,
    warmupSeconds: 0.2,
    authorization: authorization(root, "start-session", startScope),
    invocation: { scope: startScope },
    dependencyProbe: async () => true,
    randomId: () => "fixture-session",
    sessionFactory: async () => ({
      capture: async ({ outputPath }) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "fixture-image", "utf8");
        return { status: "captured", outputPath, simulated: true };
      },
      close: async () => { closed = true; return { status: "closed", simulated: true }; },
    }),
  });
  assert.equal(started.status, "ready");
  assert.equal(JSON.parse(fs.readFileSync(started.statePath, "utf8")).status, "ready");

  const captureScope = { cameraIndex: 2, operation: "capture" };
  const captured = await executeComputerCameraCapture({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    operation: "capture",
    cameraIndex: 2,
    authorization: authorization(root, "capture", captureScope),
    invocation: { scope: captureScope },
  });
  assert.equal(captured.status, "ok");
  assert.equal(fs.existsSync(captured.outputPath), true);

  const statusScope = { cameraIndex: 2, operation: "status" };
  const state = await executeComputerCameraCapture({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    operation: "status",
    cameraIndex: 2,
    authorization: authorization(root, "read-status", statusScope),
    invocation: { scope: statusScope },
  });
  assert.equal(state.cameraState.status, "ready");

  const closeScope = { cameraIndex: 2, operation: "close" };
  const closedResult = await executeComputerCameraCapture({
    dataRoot: root,
    gate: { enabled: true, configured: true },
    operation: "close",
    cameraIndex: 2,
    authorization: authorization(root, "close-session", closeScope),
    invocation: { scope: closeScope },
  });
  assert.equal(closedResult.status, "closed");
  assert.equal(closedResult.userConfirmedClose, true);
  assert.equal(closed, true);
  assert.equal(JSON.parse(fs.readFileSync(closedResult.statePath, "utf8")).status, "closed");
});
