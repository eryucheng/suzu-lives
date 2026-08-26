import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { registerLedgerIpc } from "../electron/ipc/ledger-ipc.mjs";
import { softwareAssistantUsageSubject } from "../electron/services/software-assistant-service.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-ledger-ipc-"));
}

test("ledger IPC scans suzu助手 beside every visible named contact", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const contactRoot = path.join(root, "contacts", "friend");
  const assistantSubject = softwareAssistantUsageSubject(dataRoot);
  await Promise.all([
    fs.mkdir(contactRoot, { recursive: true }),
    fs.mkdir(assistantSubject.projectRoot, { recursive: true }),
  ]);
  const handlers = new Map();
  const settingsService = {
    load: () => ({}),
    usageLedgerPath: ({ agentId }) => path.join(dataRoot, "agents", agentId, "cost-ledger", "events.jsonl"),
  };

  registerLedgerIpc({
    contactProjectsService: {
      snapshot: async () => ({
        contacts: [
          {
            agentId: "contact-agent",
            id: "contact-friend",
            name: "小林",
            projectRoot: contactRoot,
            sessionId: "contact-session",
          },
          {
            agentId: "hidden-agent",
            hidden: true,
            id: "contact-hidden",
            name: "隐私联系人",
            projectRoot: path.join(root, "contacts", "hidden"),
            sessionId: "hidden-session",
          },
        ],
      }),
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    settingsService,
    usageSubjects: [assistantSubject],
  });

  const result = await handlers.get("ledger:scan")();
  assert.deepEqual(result.contactScopes, [{ contactId: "contact-friend", contactName: "小林" }]);
  assert.deepEqual(result.usageScopes.map((scope) => [scope.subjectName, scope.subjectType]).sort(), [
    ["suzu助手", "system-assistant"],
    ["小林", "contact"],
  ]);
  assert.match(result.sources[0].detail, /2 个计费主体/u);
});
