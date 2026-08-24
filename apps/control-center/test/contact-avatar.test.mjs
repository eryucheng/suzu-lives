import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { contactAvatarSource } from "../src/core/contact-avatar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("contact avatar source prefers the matching Agent avatar and falls back to the default Agent", () => {
  const settings = {
    identity: {
      defaultAgent: { avatarDataUrl: "data:image/png;base64,DEFAULT" },
      agents: {
        "agent-momo": { avatarDataUrl: "data:image/png;base64,MOMO" },
      },
    },
  };

  assert.equal(contactAvatarSource({ agentId: "agent-momo" }, settings), "data:image/png;base64,MOMO");
  assert.equal(contactAvatarSource({ agentId: "agent-missing" }, settings), "data:image/png;base64,DEFAULT");
  assert.equal(contactAvatarSource({}, settings), "data:image/png;base64,DEFAULT");
});

test("relationship settings, compactor, and journal share the same contact avatar resolver", async () => {
  const [app, compactorPage, journalPage, relationshipPage] = await Promise.all([
    source("src", "app.mjs"),
    source("src", "react", "conversation-compactor-page.jsx"),
    source("src", "react", "agent-journal-page.jsx"),
    source("src", "react", "relationship-settings-page.jsx"),
  ]);

  for (const page of [compactorPage, journalPage, relationshipPage]) {
    assert.match(page, /import \{ contactAvatarSource \} from "\.\.\/core\/contact-avatar\.mjs";/u);
    assert.match(page, /src=\{contactAvatarSource\(contact, settings\)\}/u);
  }
  assert.match(app, /kind: "conversation-compactor",[\s\S]*?settings: state\.settings,/u);
  assert.match(app, /kind: "agent-journal",[\s\S]*?settings: state\.settings,/u);
  assert.match(app, /contact-avatar-changed"[\s\S]*?api\.settings\.get\(\)/u);
});
