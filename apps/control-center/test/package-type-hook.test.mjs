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
