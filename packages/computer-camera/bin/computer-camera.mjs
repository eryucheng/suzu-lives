#!/usr/bin/env node
import { ComputerCameraError, runComputerCameraCli } from "../src/index.mjs";

function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

try {
  const result = await runComputerCameraCli(process.argv.slice(2));
  emit(result);
  if (result.status === "error") process.exitCode = 1;
} catch (error) {
  emit({ status: "error", code: "COMPUTER_CAMERA_ERROR", error: error instanceof ComputerCameraError ? error.message : "电脑摄像头能力启动失败。" });
  process.exitCode = 1;
}
