import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PACKAGE_ROOT, "bin", "suzu-lives.mjs");

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("stable CLI dispatches merchant fixture dry-run without external services", async () => {
  const dataRoot = await temporaryDirectory("suzu-cli-automation-game-");
  const fixture = path.join(dataRoot, "merchant.html");
  await fs.writeFile(fixture, '<div>8-12点在售商品</div><span class="shop_name">棱镜球</span>', "utf8");
  const environment = { ...process.env, SUZU_LIVES_DATA_ROOT: dataRoot };

  const merchant = await execFileAsync(
    process.execPath,
    [CLI, "traveling-merchant", "--dry-run", "--fixture", fixture],
    { cwd: PACKAGE_ROOT, env: environment },
  );
  const merchantResult = JSON.parse(merchant.stdout);
  assert.equal(merchantResult.status, "match");
  assert.equal(merchantResult.deliveryReady, false);
  await assert.rejects(() => fs.stat(path.join(dataRoot, "automation", "traveling-merchant", "runtime", "state.json")), /ENOENT/u);

});
