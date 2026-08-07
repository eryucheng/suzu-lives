import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeClaudeProjectDirectory,
  resolveAgentDataRoot,
  resolveAgentConversationDataRoot,
  resolveSuzuLivesDataRoot,
  resolveTranscriptPath,
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

test("selects the newest Claude project transcript as the final fallback", async () => {
  const homeDirectory = temporaryDirectory("suzu-home-");
  const projectRoot = temporaryDirectory("suzu-auto-transcript-");
  const sessions = path.join(
    homeDirectory,
    ".claude",
    "projects",
    encodeClaudeProjectDirectory(projectRoot),
  );
  fs.mkdirSync(sessions, { recursive: true });
  const older = path.join(sessions, "older.jsonl");
  const newer = path.join(sessions, "newer.jsonl");
  fs.writeFileSync(older, "{}\n", "utf8");
  fs.writeFileSync(newer, "{}\n{}\n", "utf8");
  const now = Date.now() / 1000;
  fs.utimesSync(older, now - 30, now - 30);
  fs.utimesSync(newer, now, now);

  const result = await resolveTranscriptPath(projectRoot, { homeDirectory });
  assert.deepEqual(result, { path: newer, source: "auto" });
});

test("returns a missing result instead of inventing a transcript path", async () => {
  const root = temporaryDirectory("suzu-missing-transcript-");
  const homeDirectory = temporaryDirectory("suzu-missing-home-");
  const result = await resolveTranscriptPath(root, { homeDirectory });
  assert.deepEqual(result, { path: "", source: "missing" });
});
