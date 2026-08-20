import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { default: afterPack, packageTypeForTargets } = require("../scripts/package-type-hook.cjs");

test("Windows packaging writes the actual installer type into resources", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-lives-package-type-"));
  try {
    const appOutDir = path.join(temporaryRoot, "win-unpacked");
    await afterPack({ appOutDir, electronPlatformName: "win32", targets: [{ name: "nsis" }] });
    assert.equal(await fs.readFile(path.join(appOutDir, "resources", "package-type"), "utf8"), "nsis\n");

    const zipOutDir = path.join(temporaryRoot, "zip-unpacked");
    await afterPack({ appOutDir: zipOutDir, electronPlatformName: "win32", targets: [{ name: "zip" }] });
    assert.equal(await fs.readFile(path.join(zipOutDir, "resources", "package-type"), "utf8"), "zip\n");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows packaging rejects mixed distribution targets", () => {
  assert.throws(
    () => packageTypeForTargets([{ name: "nsis" }, { name: "zip" }]),
    /一种分发目标/u,
  );
});

test("desktop packaging keeps the private Agent Core native runtime beside its unpacked bundle", async () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
  const nativeRuntimeSource = "../../packages/suzu-agent-runtime/vendor/core/node_modules";
  const nativeRuntimeTarget = "agent-core-native/node_modules";
  assert.ok(
    manifest.build?.extraResources?.some((entry) => entry?.from === nativeRuntimeSource && entry?.to === nativeRuntimeTarget),
    "打包配置必须将 Agent Core 私有 native node_modules 复制到 resources；否则安装版无法启动 Agent Core 子进程。",
  );
  assert.ok(
    manifest.build?.asarUnpack?.includes("node_modules/@suzu-lives/suzu-agent-runtime/**"),
    "Agent Core JavaScript bundle 必须位于 asar 外，供子进程解析。",
  );
});

test("desktop packaging uses Suzu Lives as its public product name", async () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.build?.productName, "Suzu Lives");
  assert.equal(manifest.build?.win?.artifactName, "Suzu-Lives-${version}-win-${arch}.${ext}");
});

test("the release workflow matches the current public installer name", async () => {
  const workflow = await fs.readFile(new URL("../../../.github/workflows/release-windows.yml", import.meta.url), "utf8");
  assert.match(workflow, /Suzu-Lives-\*-win-x64\.exe/u);
  assert.doesNotMatch(workflow, /Suzu-Lives-Console/u);
});

test("capability IPC declares every direct Suzu package it imports as a production dependency", async () => {
  const root = new URL("..", import.meta.url);
  const [manifestText, capabilityIpc] = await Promise.all([
    fs.readFile(new URL("package.json", root), "utf8"),
    fs.readFile(new URL("electron/ipc/capabilities-ipc.mjs", root), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const imports = [...new Set(
    [...capabilityIpc.matchAll(/from\s+["'](@suzu-lives\/[^"']+)["']/gu)]
      .map((match) => match[1].match(/^(@suzu-lives\/[^/]+)/u)?.[1])
      .filter(Boolean),
  )];

  for (const packageName of imports) {
    assert.ok(
      manifest.dependencies?.[packageName],
      `capabilities-ipc.mjs imports ${packageName}, but the desktop package does not declare it as a production dependency`,
    );
  }
});
