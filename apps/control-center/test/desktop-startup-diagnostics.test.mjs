import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createDesktopStartupDiagnostics,
  resolveDesktopStartupDiagnosticDirectory,
} from "../scripts/desktop-startup-diagnostics.mjs";

async function temporaryDirectory() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-startup-diagnostics-"));
}

test("desktop startup diagnostics default to D:\\Temp on Windows", () => {
  assert.equal(
    resolveDesktopStartupDiagnosticDirectory({ environment: {}, platform: "win32" }),
    path.join("D:\\Temp", "suzu-lives-desktop-startup"),
  );
  assert.equal(
    resolveDesktopStartupDiagnosticDirectory({
      environment: { SUZU_LIVES_STARTUP_LOG_DIRECTORY: "D:\\Logs\\suzu-startup" },
      platform: "win32",
    }),
    path.join("D:\\Logs", "suzu-startup"),
  );
});

test("desktop startup diagnostics append bounded, structured records", async () => {
  const directory = await temporaryDirectory();
  const diagnostics = createDesktopStartupDiagnostics({ directory });
  diagnostics.record("launcher.start", { rendererPort: 5173 });
  diagnostics.recordOutput("vite.stderr", "x".repeat(7_000));
  await diagnostics.flush();

  const lines = (await fs.readFile(diagnostics.logPath, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(lines[0].event, "launcher.start");
  assert.equal(lines[0].rendererPort, 5173);
  assert.equal(lines[1].event, "vite.stderr");
  assert.match(lines[1].output, /\[truncated\]/u);
  assert.ok(lines[1].output.length < 6_100);
});
