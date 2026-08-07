import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseVisualReferenceManagerArgs,
  runVisualReferenceManagerCli,
  VisualReferenceManagerError,
} from "../src/index.mjs";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-visual-manager-")); }

test("stable manager preserves init, dry-run/apply, list, show, validate, and data-root ownership", async () => {
  const root = await temporary(); const source = path.join(root, "source.png"); const planPath = path.join(root, "plan.json");
  await fs.writeFile(source, png);
  const environment = { SUZU_LIVES_DATA_ROOT: path.join(root, "software-data"), SUZU_LIVES_AGENT_ID: "fixture" };
  const call = (values) => runVisualReferenceManagerCli(values, { environment });
  const initialized = await call(["init"]);
  assert.equal(initialized.status, "ready");
  assert.equal(await fs.stat(initialized.manifest).then((item) => item.isFile()), true);
  assert.equal(await fs.stat(path.join(path.dirname(initialized.manifest), "characters")).then((item) => item.isDirectory()), true);
  await fs.writeFile(planPath, JSON.stringify({ version: 1, sets: { "character-main": "主角" }, operations: [{ action: "add", source, id: "character.main.face-front", role: "identity", description: "正面", preserve: ["脸部"], ignore: ["背景"], sets: ["character-main"] }] }));
  const preview = await call(["apply", "--plan", planPath, "--dry-run"]);
  assert.equal(preview.status, "dry-run");
  assert.equal(preview.asset_count, 1);
  const target = path.join(path.dirname(initialized.manifest), "characters", "character", "main", "face-front.png");
  assert.equal(await fs.stat(target).then(() => true).catch(() => false), false);
  const written = await call(["apply", "--plan", planPath]);
  assert.equal(written.status, "written");
  assert.equal(await fs.stat(target).then((item) => item.isFile()), true);
  const listed = await call(["list", "--query", "主角"]);
  assert.equal(listed.matched_asset_count, 1);
  assert.equal(listed.assets[0].id, "character.main.face-front");
  const shown = await call(["show", "character.main.face-front"]);
  assert.deepEqual(shown.sets, ["character-main"]);
  assert.equal(shown.path, "characters/character/main/face-front.png");
  const valid = await call(["validate"]);
  assert.deepEqual({ status: valid.status, asset_count: valid.asset_count, set_count: valid.set_count }, { status: "valid", asset_count: 1, set_count: 1 });
});

test("apply validates a whole plan before writing any partial library state", async () => {
  const root = await temporary(); const source = path.join(root, "source.png"); const planPath = path.join(root, "bad-plan.json");
  await fs.writeFile(source, png);
  const environment = { SUZU_LIVES_DATA_ROOT: path.join(root, "software-data"), SUZU_LIVES_AGENT_ID: "fixture" };
  const call = (values) => runVisualReferenceManagerCli(values, { environment });
  const initialized = await call(["init"]);
  await fs.writeFile(planPath, JSON.stringify({ version: 1, sets: {}, operations: [
    { action: "add", source, id: "character.main.face", role: "identity", description: "正面", preserve: [], ignore: [], sets: [] },
    { action: "add", source: path.join(root, "missing.png"), id: "character.main.profile", role: "identity", description: "侧面", preserve: [], ignore: [], sets: [] },
  ] }));
  await assert.rejects(() => call(["apply", "--plan", planPath]), VisualReferenceManagerError);
  const result = await call(["list"]);
  assert.equal(result.asset_count, 0);
  assert.equal(await fs.stat(path.join(path.dirname(initialized.manifest), "characters", "character", "main", "face.png")).then(() => true).catch(() => false), false);
});

test("argument validation accepts supported commands while preventing manifest escapes", async () => {
  assert.deepEqual(parseVisualReferenceManagerArgs(["list", "--query", "卧室", "--limit", "10"]), { command: "list", manifest: "", plan: "", query: "卧室", role: "", limit: 10, dryRun: false });
  assert.throws(() => parseVisualReferenceManagerArgs(["apply"]), VisualReferenceManagerError);
  const root = await temporary();
  await assert.rejects(
    () => runVisualReferenceManagerCli(["init", "--manifest", "../outside/manifest.json"], { environment: { SUZU_LIVES_DATA_ROOT: path.join(root, "software-data"), SUZU_LIVES_AGENT_ID: "fixture" } }),
    VisualReferenceManagerError,
  );
  assert.equal(await fs.stat(path.join(root, "outside", "manifest.json")).then(() => true).catch(() => false), false);
});
