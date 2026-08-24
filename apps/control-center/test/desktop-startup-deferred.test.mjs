import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("desktop background recovery begins only after the renderer signals its first paint", () => {
  const ipc = readFileSync(resolve(ROOT, "electron", "ipc", "index.mjs"), "utf8");

  assert.match(ipc, /const startBackgroundServices = \(\) => \{/u);
  assert.match(ipc, /memoryService\.resumeExistingMaintenance\(\)\.catch\(\(\) => undefined\)/u);
  assert.match(ipc, /rendererIpcMain\.handle\("app-lifecycle:renderer-ready", \(event\) => \{[\s\S]*?void startBackgroundServices\(\);/u);
  assert.doesNotMatch(ipc, /void memoryService\.resumeExistingMaintenance\(\)\.catch\(\(\) => undefined\);\s*const conversationCompactorService/u);
});
