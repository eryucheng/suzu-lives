import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
  const temporaryRoot = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryRoot, "suzu-system-status-"));
  const dataRoot = path.join(root, "Suzu Lives");
  const contactsRoot = path.join(root, "Contacts");
  const project = path.join(contactsRoot, CONTACT_ID);
  await writeJson(path.join(dataRoot, "settings.json"), { theme: "light", identity: {} });
  await fs.writeFile(path.join(dataRoot, "SUZU.md"), "# 全局 Suzu 设定\n", "utf8");
  await fs.mkdir(path.join(dataRoot, "agents", AGENT_ID), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "capabilities", "image-generation"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "software-assistant", "workspace"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "outside-data.txt"), "outside", "utf8");
  await fs.mkdir(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", "suzu-companion"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", "suzu-software-assistant"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "agent-runtime", "core", "settings.yaml"), "llm-deepseek: {}\n", "utf8");
  await fs.writeFile(path.join(dataRoot, "agent-runtime", "core", ".credentials.yaml"), "DEEPSEEK_API_KEY: secret-agent-core-key\n", "utf8");
  await fs.writeFile(path.join(dataRoot, "agent-runtime", "core", "AGENTS.md"), "# 私有指令桥接\n", "utf8");
  await fs.writeFile(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", "suzu-companion", "agent.cordis.yml"), "- id: tool-pwsh\n", "utf8");
  await fs.writeFile(path.join(dataRoot, "agent-runtime", "core", ".agent-presets", "suzu-software-assistant", "agent.cordis.yml"), "- id: software-assistant\n", "utf8");
  await fs.mkdir(path.join(project, ".suzu-lives"), { recursive: true });
  await fs.writeFile(path.join(project, "SUZU.md"), "# Contact\n", "utf8");
  await writeJson(path.join(project, ".suzu-lives", "contact.json"), {
    version: 1,
    id: CONTACT_ID,
    name: "Suzu",
    createdAt: "2026-08-15T00:00:00.000Z",
    agentId: AGENT_ID,
  });
  await fs.mkdir(path.join(contactsRoot, "my-manual-project"), { recursive: true });
  const settingsService = { load: () => ({ contactsRoot }) };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    dataRoot,
    service: createSystemStatusService({ dataRoot, settingsService }),
  };
}

test("system status audits Suzu and Agent Core files", async (t) => {
  const values = await fixture(t);
  const snapshot = await values.service.scan();

  assert.equal(snapshot.summary.status, "ready");
  assert.ok(snapshot.summary.external >= 2);
  assert.equal(itemById(snapshot, "data-root:outside-data.txt")?.ownership, "external");
  assert.equal(itemById(snapshot, "contact:my-manual-project")?.ownership, "external");
  assert.equal(itemById(snapshot, `contact:${CONTACT_ID}:instructions`)?.title, "SUZU.md");
  assert.equal(itemById(snapshot, "data-root:global-instructions")?.ownership, "managed");
  assert.equal(itemById(snapshot, "data-root:software-assistant")?.ownership, "managed");
  assert.equal(itemById(snapshot, "agent-core:credentials")?.title, "Suzu 本机模型凭据（内容不显示）");
  assert.equal(itemById(snapshot, "agent-core:instruction-bridge")?.ownership, "managed");
  assert.equal(itemById(snapshot, "agent-core:companion-preset")?.title, "Suzu 陪伴 preset（PowerShell / 文件）");
  assert.equal(itemById(snapshot, "agent-core:software-assistant-preset")?.title, "Suzu 软件助手 preset（独立会话）");
  assert.ok(snapshot.sections.some((section) => section.id === "agent-core"));

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-agent-core-key/u);
});
