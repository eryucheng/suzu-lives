import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SUZU_GLOBAL_INSTRUCTIONS,
  SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE,
  SUZU_GLOBAL_INSTRUCTIONS_FILE,
  SuzuInstructionBridgeError,
  createSuzuInstructionBridge,
} from "../electron/services/suzu-instruction-bridge.mjs";

async function temporaryRoot() {
  const base = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, "suzu-lives-instruction-bridge-"));
}

test("the global SUZU.md is created once and mirrored into the private Agent Core entry", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const runtimeHome = path.join(root, "runtime", "core");
  const bridge = createSuzuInstructionBridge({ dataRoot, runtimeHome });

  const first = await bridge.sync();
  assert.equal(first.createdGlobal, true);
  assert.equal(first.changed, true);
  assert.equal(first.globalPath, path.join(dataRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE));
  assert.equal(first.bridgePath, path.join(runtimeHome, SUZU_AGENT_GLOBAL_INSTRUCTIONS_BRIDGE_FILE));
  assert.equal(DEFAULT_SUZU_GLOBAL_INSTRUCTIONS, "");
  assert.equal(await fs.readFile(first.globalPath, "utf8"), DEFAULT_SUZU_GLOBAL_INSTRUCTIONS);
  assert.equal(await fs.readFile(first.bridgePath, "utf8"), DEFAULT_SUZU_GLOBAL_INSTRUCTIONS);

  const second = await bridge.sync();
  assert.equal(second.createdGlobal, false);
  assert.equal(second.changed, false);

  await fs.writeFile(first.globalPath, "# 新的 Suzu 设定\n\n更具体的语气。\n", "utf8");
  const third = await bridge.sync();
  assert.equal(third.changed, true);
  assert.equal(await fs.readFile(third.bridgePath, "utf8"), "# 新的 Suzu 设定\n\n更具体的语气。\n");
});

test("the bridge refuses unsafe links and oversized global instructions", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const runtimeHome = path.join(root, "runtime", "core");
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(path.join(dataRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE), "超出上限", "utf8");
  const oversized = createSuzuInstructionBridge({ dataRoot, runtimeHome, maxSourceBytes: 2 });
  await assert.rejects(
    oversized.sync(),
    (error) => error instanceof SuzuInstructionBridgeError && error.code === "SOURCE_TOO_LARGE",
  );

  const target = path.join(root, "outside.md");
  await fs.writeFile(target, "外部内容", "utf8");
  await fs.rm(path.join(dataRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE));
  try {
    await fs.symlink(target, path.join(dataRoot, SUZU_GLOBAL_INSTRUCTIONS_FILE), "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return;
    throw error;
  }
  const bridged = createSuzuInstructionBridge({ dataRoot, runtimeHome });
  await assert.rejects(
    bridged.sync(),
    (error) => error instanceof SuzuInstructionBridgeError && error.code === "UNSAFE_SYMBOLIC_LINK",
  );
});
