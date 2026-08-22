import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path, { basename } from "node:path";
import test from "node:test";

import { resolveSuzuAgentCoreModule } from "../src/core-module-catalog.mjs";
import { SuzuJsonlSessionPersistence } from "../src/session-persistence-jsonl-compat.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-session-persistence-compat-"));
}

test("the Core persistence role resolves through Suzu's zstd/JSONL compatibility wrapper", () => {
  assert.equal(
    basename(resolveSuzuAgentCoreModule("session-persistence-jsonl")),
    "session-persistence-jsonl-compat.mjs",
  );
});

test("zstd persistence ignores only the raw JSONL peer during encoding discovery", async () => {
  const root = await temporaryRoot();
  const rawArtifact = path.join(root, "session.jsonl");
  const compressedArtifact = `${rawArtifact}.zstd`;
  await fs.writeFile(rawArtifact, "raw-event-chain", "utf8");
  await fs.writeFile(compressedArtifact, "zstd-session", "utf8");

  const persistence = { compression: "zstd" };
  assert.equal(await SuzuJsonlSessionPersistence.prototype.exists.call(persistence, rawArtifact), false);
  assert.equal(await SuzuJsonlSessionPersistence.prototype.exists.call(persistence, compressedArtifact), true);

  const rawOnlyArtifact = path.join(root, "raw-only", "session.jsonl");
  await fs.mkdir(path.dirname(rawOnlyArtifact), { recursive: true });
  await fs.writeFile(rawOnlyArtifact, "raw-only-event-chain", "utf8");
  const rawOnlyPersistence = {
    compression: "zstd",
    async assertLogParentAllowsAbsence() {},
  };
  assert.equal(await SuzuJsonlSessionPersistence.prototype.exists.call(rawOnlyPersistence, rawOnlyArtifact), true);
  assert.equal(await SuzuJsonlSessionPersistence.prototype.exists.call({ compression: "none" }, rawArtifact), true);
});
