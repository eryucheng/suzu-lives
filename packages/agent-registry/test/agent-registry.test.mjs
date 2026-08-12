import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveAgentDataRoot,
  resolveAgentConversationDataRoot,
  resolveSuzuLivesDataRoot,
  stableAgentId,
} from "../src/index.mjs";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("generates a stable Agent ID from a normalized project path", () => {
  const root = temporaryDirectory("suzu-agent-id-");
  const first = stableAgentId(root);
  const second = stableAgentId(path.join(root, "."));
  assert.match(first, /^agent-[a-f0-9]{16}$/u);
  assert.equal(first, second);
  assert.equal(stableAgentId(""), "");
});

test("builds software and Agent data roots without depending on Electron", () => {
  const localAppData = temporaryDirectory("suzu-local-data-");
  const projectRoot = temporaryDirectory("suzu-project-");
  const dataRoot = resolveSuzuLivesDataRoot({
    configuredRoot: "",
    localAppData,
    fallbackBase: "",
    appData: "",
  });
  assert.equal(dataRoot, path.join(localAppData, "Suzu Lives"));
  assert.equal(
    resolveAgentDataRoot({ dataRoot, projectRoot }),
    path.join(dataRoot, "agents", stableAgentId(projectRoot)),
  );
  assert.equal(
    resolveAgentConversationDataRoot({ dataRoot, projectRoot, sessionId: "session-1" }),
    path.join(dataRoot, "agents", stableAgentId(projectRoot), "conversations", "session-1"),
  );
  assert.throws(() => resolveAgentConversationDataRoot({ dataRoot, projectRoot, sessionId: "../outside" }), /sessionId/u);
});
