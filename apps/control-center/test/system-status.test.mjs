import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSystemStatusService } from "../electron/services/system-status.mjs";

const CONTACT_ID = "contact-11111111-1111-4111-8111-111111111111";
const AGENT_ID = "agent-contact-one";

async function writeJson(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function itemById(snapshot, id) {
  return snapshot.sections.flatMap((section) => section.items).find((entry) => entry.id === id) || null;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-system-status-"));
  const dataRoot = path.join(root, "Suzu Lives");
  const contactsRoot = path.join(root, "Contacts");
  const home = path.join(root, "Home");
  const project = path.join(contactsRoot, CONTACT_ID);
  await writeJson(path.join(dataRoot, "settings.json"), { theme: "light", identity: {} });
  await fs.mkdir(path.join(dataRoot, "agents", AGENT_ID), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "capabilities", "image-generation"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "outside-data.txt"), "outside", "utf8");
  await fs.mkdir(path.join(project, ".claude", "skills", "suzu-lives-voice"), { recursive: true });
  await fs.mkdir(path.join(project, ".claude", "skills", "my-manual-skill"), { recursive: true });
  await fs.mkdir(path.join(project, ".suzu-lives"), { recursive: true });
  await fs.writeFile(path.join(project, "CLAUDE.md"), "# Contact\n", "utf8");
  await writeJson(path.join(project, ".suzu-lives", "contact.json"), {
    version: 1,
    id: CONTACT_ID,
    name: "Suzu",
    createdAt: "2026-08-15T00:00:00.000Z",
    agentId: AGENT_ID,
  });
  await writeJson(path.join(project, ".claude", "settings.json"), {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", args: ["--suzu-lives-hook", "memory-recall"] }] }] },
    permissions: { allow: ["Read(*)"] },
  });
  await fs.writeFile(path.join(project, ".claude", "skills", "suzu-lives-voice", "SKILL.md"), "managed", "utf8");
  await fs.writeFile(path.join(project, ".claude", "skills", "my-manual-skill", "SKILL.md"), "external", "utf8");
  await fs.mkdir(path.join(contactsRoot, "my-manual-project"), { recursive: true });
  await writeJson(path.join(home, ".claude", "settings.json"), {
    env: {
      ANTHROPIC_AUTH_TOKEN: "secret-token-must-not-leak",
      MY_CUSTOM_VARIABLE: "secret-custom-value-must-not-leak",
    },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "not-run" }] }] },
    mcpServers: { customServer: { command: "not-returned" } },
  });
  await writeJson(path.join(home, ".claude.json"), { hasCompletedOnboarding: true });
  await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "manual instruction", "utf8");
  const settingsService = { load: () => ({ contactsRoot }) };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    dataRoot,
    home,
    globalSettings: path.join(home, ".claude", "settings.json"),
    service: createSystemStatusService({ dataRoot, homeDirectory: home, settingsService }),
  };
}

test("system status lists external additions and redacts Claude configuration values", async (t) => {
  const values = await fixture(t);
  const before = await fs.readFile(values.globalSettings, "utf8");
  const snapshot = await values.service.scan();

  assert.equal(snapshot.summary.status, "ready");
  assert.ok(snapshot.summary.external >= 4);
  assert.equal(itemById(snapshot, "data-root:outside-data.txt")?.ownership, "external");
  assert.equal(itemById(snapshot, "contact:my-manual-project")?.ownership, "external");
  assert.equal(itemById(snapshot, `contact:${CONTACT_ID}:skill:my-manual-skill`)?.ownership, "external");

  const globalSettings = itemById(snapshot, "global-claude-settings");
  assert.equal(globalSettings?.ownership, "shared");
  assert.deepEqual(globalSettings?.metadata?.env?.managedKeys, ["ANTHROPIC_AUTH_TOKEN"]);
  assert.deepEqual(globalSettings?.metadata?.env?.customKeys, ["MY_CUSTOM_VARIABLE"]);
  assert.deepEqual(globalSettings?.metadata?.hooks?.events, ["Stop"]);
  assert.deepEqual(globalSettings?.metadata?.mcpServers?.shown, ["customServer"]);

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-token-must-not-leak|secret-custom-value-must-not-leak|not-returned/u);
  assert.equal(await fs.readFile(values.globalSettings, "utf8"), before);
});

test("system status reports an invalid user-level Claude settings file without failing the whole scan", async (t) => {
  const values = await fixture(t);
  await fs.writeFile(values.globalSettings, "{ invalid json", "utf8");

  const snapshot = await values.service.scan();
  const globalSettings = itemById(snapshot, "global-claude-settings");

  assert.equal(snapshot.summary.status, "error");
  assert.equal(globalSettings?.state, "error");
  assert.match(globalSettings?.detail || "", /有效的 JSON/u);
});
