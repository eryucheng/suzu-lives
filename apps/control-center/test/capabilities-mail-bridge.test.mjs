import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createCapabilitiesService } from "../electron/ipc/capabilities-ipc.mjs";

async function temporaryDirectory(prefix) {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix));
}

function serviceFor(dataRoot, synchronized = []) {
  return createCapabilitiesService({
    capabilityRuntime: {
      removeContact: async () => undefined,
      sync: async ({ capabilityId, reason }) => synchronized.push({ capabilityId, reason }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });
}

function mailSettings(snapshot) {
  return snapshot.capabilities.find((capability) => capability.id === "mail-bridge")?.savedSettings || {};
}

test("mail bridge saves a user-facing business mail Skill without requiring mailbox details", async () => {
  const root = await temporaryDirectory("suzu-lives-mail-business-skill-");
  const dataRoot = path.join(root, "data");
  const synchronized = [];
  const service = serviceFor(dataRoot, synchronized);

  const snapshot = await service.saveSettings({
    id: "mail-bridge",
    value: {
      mailSkillName: "查岗",
      mailSkillDescription: "当用户要确认对方是否在岗时，发一封查岗邮件。",
      mailSkillSubject: "查岗",
    },
  });

  const configPath = path.join(dataRoot, "automation", "mail-bridge", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.agentSkills.length, 1);
  assert.match(config.agentSkills[0].id, /^rule-[a-f0-9-]+$/u);
  assert.deepEqual({ ...config.agentSkills[0], id: "generated" }, {
    id: "generated",
    name: "查岗",
    description: "当用户要确认对方是否在岗时，发一封查岗邮件。",
    subject: "查岗",
  });
  assert.equal(Object.hasOwn(config, "agentDelivery"), false);
  assert.deepEqual(synchronized, [{ capabilityId: "mail-bridge", reason: "mail-skill-saved" }]);

  const settings = mailSettings(snapshot);
  assert.equal(settings.saved, false);
  assert.deepEqual(settings.configuration.agentSkills, config.agentSkills);
  assert.equal(Object.hasOwn(settings.configuration, "routePrompt"), false);
  assert.equal(Object.hasOwn(settings.configuration, "routeSubject"), false);
});

test("mail bridge keeps business Skills while saving the mailbox connection and can remove one", async () => {
  const root = await temporaryDirectory("suzu-lives-mail-connection-");
  const dataRoot = path.join(root, "data");
  const synchronized = [];
  const service = serviceFor(dataRoot, synchronized);

  await service.saveSettings({
    id: "mail-bridge",
    value: {
      mailSkillName: "查岗",
      mailSkillDescription: "需要确认对方是否在岗时使用。",
      mailSkillSubject: "查岗",
    },
  });
  const firstConfig = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "mail-bridge", "config.json"), "utf8"));
  const skillId = firstConfig.agentSkills[0].id;

  const snapshot = await service.saveSettings({
    id: "mail-bridge",
    value: {
      sender: "sender@example.test",
      recipient: "automation@example.test",
      username: "sender@example.test",
      allowedSenders: "automation@example.test",
      passwordEnv: "SUZU_MAIL_PASSWORD",
      feedbackSubject: "自动化回信",
    },
  });

  const configPath = path.join(dataRoot, "automation", "mail-bridge", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.outbound.sender, "sender@example.test");
  assert.equal(config.outbound.recipient, "automation@example.test");
  assert.equal(config.mail.username, "sender@example.test");
  assert.equal(config.routes.length, 1);
  assert.equal(config.routes[0].subject, "自动化回信");
  assert.match(config.routes[0].promptTemplate, /\{\{content\}\}/u);
  assert.equal(config.agentSkills[0].id, skillId);

  const settings = mailSettings(snapshot);
  assert.equal(settings.saved, true);
  assert.equal(settings.configuration.feedbackSubject, "自动化回信");
  assert.equal(settings.configuration.agentSkills[0].name, "查岗");

  const removed = await service.saveSettings({
    id: "mail-bridge",
    value: { removeMailSkillId: skillId },
  });
  const afterRemove = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(afterRemove.agentSkills, []);
  assert.deepEqual(mailSettings(removed).configuration.agentSkills, []);
  assert.deepEqual(synchronized.map((item) => item.reason), ["mail-skill-saved", "settings-saved", "mail-skill-removed"]);
});

test("editing a legacy delivery rule migrates it into a business mail Skill", async () => {
  const root = await temporaryDirectory("suzu-lives-mail-legacy-");
  const dataRoot = path.join(root, "data");
  const configPath = path.join(dataRoot, "automation", "mail-bridge", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    agentDelivery: {
      subject: "自动化待办",
      description: "把明确的待办同步给外部自动化。",
    },
  }), "utf8");
  const service = serviceFor(dataRoot);

  await service.saveSettings({
    id: "mail-bridge",
    value: {
      mailSkillId: "rule-legacy",
      mailSkillName: "待办同步",
      mailSkillDescription: "用户要求同步待办到外部自动化时使用。",
      mailSkillSubject: "自动化待办",
    },
  });

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(Object.hasOwn(config, "agentDelivery"), false);
  assert.deepEqual(config.agentSkills, [{
    id: "rule-legacy",
    name: "待办同步",
    description: "用户要求同步待办到外部自动化时使用。",
    subject: "自动化待办",
  }]);
});
