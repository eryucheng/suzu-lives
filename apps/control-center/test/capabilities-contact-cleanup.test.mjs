import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCapabilitiesService } from "../electron/ipc/capabilities-ipc.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeConfig(dataRoot, segments, value) {
  const filePath = path.join(dataRoot, ...segments);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

test("capability contact pickers omit hidden contacts", async () => {
  const dataRoot = await temporaryDirectory("suzu-capability-visible-contacts-");
  const service = createCapabilitiesService({
    contactProjectsService: {
      snapshot: async () => ({
        status: "ready",
        contacts: [
          { id: "contact-visible", name: "可见联系人" },
          { hidden: true, id: "contact-hidden", name: "隐私联系人" },
        ],
      }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  assert.deepEqual(await service.companionTargets(), {
    status: "ready",
    contacts: [{ id: "contact-visible", name: "可见联系人" }],
  });
});

test("removing a contact clears it from every contact-scoped capability config", async () => {
  const dataRoot = await temporaryDirectory("suzu-capability-contact-cleanup-");
  const removedId = "contact-delete-me";
  const retainedId = "contact-keep-me";
  const paths = [
    ["automation", "proactive-contact", "config.json"],
    ["automation", "mail-bridge", "config.json"],
    ["capabilities", "image-vision", "config.json"],
  ];
  for (const segments of paths) {
    await writeConfig(dataRoot, segments, {
      enabledContactIds: [removedId, retainedId],
      knownContactIds: [retainedId, removedId],
      untouched: true,
    });
  }
  const synchronizedCapabilityIds = [];
  const removedContacts = [];
  const service = createCapabilitiesService({
    capabilityRuntime: {
      sync: async ({ capabilityId }) => { synchronizedCapabilityIds.push(capabilityId); },
      removeContact: async ({ contactId }) => { removedContacts.push(contactId); },
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  const result = await service.removeContact({ contactId: removedId });
  assert.equal(result.updated, paths.length);
  assert.deepEqual(new Set(synchronizedCapabilityIds), new Set([
    "image-vision",
    "mail-bridge",
    "proactive-contact",
  ]));
  assert.deepEqual(removedContacts, [removedId]);
  for (const segments of paths) {
    const saved = JSON.parse(await fs.readFile(path.join(dataRoot, ...segments), "utf8"));
    assert.deepEqual(saved.enabledContactIds, [retainedId]);
    assert.deepEqual(saved.knownContactIds, [retainedId]);
    assert.equal(saved.untouched, true);
  }
});

test("Agent Core capability initialization keeps capability state in the product runtime", async () => {
  const root = await temporaryDirectory("suzu-capability-voice-call-");
  const dataRoot = path.join(root, "software-data");
  const existingProject = path.join(root, "existing-contact");
  const newProject = path.join(root, "new-contact");
  await Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(existingProject), fs.mkdir(newProject)]);
  const synchronized = [];
  const service = createCapabilitiesService({
    capabilityRuntime: {
      removeContact: async () => undefined,
      sync: async ({ capabilityId, reason, scope }) => { synchronized.push({ capabilityId, reason, scope }); },
    },
    contactProjectsService: {
      snapshot: async () => ({ contacts: [{ id: "contact-existing", projectRoot: existingProject }] }),
    },
    settingsService: {
      load: () => ({ dataRoot, projectRoot: existingProject }),
      response: () => ({ dataRoot }),
    },
  });

  const refreshed = await service.refreshManagedRegistrations();
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.errors.length, 0);
  assert.deepEqual(synchronized, [{
    capabilityId: "proactive-contact",
    reason: "default-contact-migration",
    scope: undefined,
  }]);
  const migratedSettings = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "proactive-contact", "config.json"), "utf8"));
  assert.deepEqual(migratedSettings.enabledContactIds, ["contact-existing"]);

  const initialized = await service.initializeDefaultContactCapabilities({ id: "contact-new", projectRoot: newProject });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.status, "ready");
  assert.equal(initialized.errors.length, 0);
  assert.deepEqual(synchronized, [
    { capabilityId: "proactive-contact", reason: "default-contact-migration", scope: undefined },
    { capabilityId: "proactive-contact", reason: "contact-created", scope: { contactId: "contact-new" } },
  ]);
  const proactiveSettings = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "proactive-contact", "config.json"), "utf8"));
  assert.equal(proactiveSettings.autoMaintain, true);
  assert.deepEqual(proactiveSettings.enabledContactIds, ["contact-existing", "contact-new"]);
  const snapshot = service.snapshot();
  assert.equal(snapshot.runtime, "agent-core");
  assert.equal(snapshot.capabilities.find((capability) => capability.id === "voice-message")?.runtimeStatus, "agent-capability-bridge");
  assert.equal(snapshot.capabilities.find((capability) => capability.id === "proactive-contact")?.savedSettings.enabledContactIds.includes("contact-new"), true);
});

test("proactive-contact default migration preserves an explicitly saved contact selection", async () => {
  const root = await temporaryDirectory("suzu-capability-proactive-default-");
  const dataRoot = path.join(root, "software-data");
  const contactId = "contact-existing";
  await writeConfig(dataRoot, ["automation", "proactive-contact", "config.json"], {
    enabledContactIds: [],
  });
  const synchronized = [];
  const service = createCapabilitiesService({
    capabilityRuntime: {
      removeContact: async () => undefined,
      sync: async ({ capabilityId }) => { synchronized.push(capabilityId); },
    },
    contactProjectsService: {
      snapshot: async () => ({ contacts: [{ id: contactId, projectRoot: path.join(root, "contact") }] }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  const refreshed = await service.refreshManagedRegistrations();
  assert.equal(refreshed.refreshed, false);
  assert.deepEqual(synchronized, []);
  const settings = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "proactive-contact", "config.json"), "utf8"));
  assert.deepEqual(settings.enabledContactIds, []);
});

test("proactive-contact settings keep the contact prompt and remove the obsolete follow-up prompt", async () => {
  const root = await temporaryDirectory("suzu-capability-proactive-prompt-");
  const dataRoot = path.join(root, "software-data");
  const configPath = ["automation", "proactive-contact", "config.json"];
  await writeConfig(dataRoot, configPath, {
    chainPrompt: "旧的联系原则。",
    followUpPrompt: "旧的回访原则。",
    autoMaintain: true,
    enabledContactIds: ["contact-prompt"],
  });
  const service = createCapabilitiesService({
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  assert.equal(service.proactiveContactSettings().contactPrompt, "旧的联系原则。");
  await service.saveSettings({
    id: "proactive-contact",
    value: {
      contactPrompt: "当前的联系原则。",
    },
  });

  const saved = JSON.parse(await fs.readFile(path.join(dataRoot, ...configPath), "utf8"));
  assert.equal(saved.contactPrompt, "当前的联系原则。");
  assert.equal(Object.hasOwn(saved, "followUpPrompt"), false);
  assert.equal(Object.hasOwn(saved, "chainPrompt"), false);
});

test("proactive-contact startup cleanup removes the obsolete follow-up prompt without changing saved contacts", async () => {
  const root = await temporaryDirectory("suzu-capability-proactive-follow-up-cleanup-");
  const dataRoot = path.join(root, "software-data");
  const configPath = ["automation", "proactive-contact", "config.json"];
  await writeConfig(dataRoot, configPath, {
    contactPrompt: "保持自然。",
    followUpPrompt: "旧的回访原则。",
    autoMaintain: false,
    enabledContactIds: ["contact-existing"],
  });
  const service = createCapabilitiesService({
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  const refreshed = await service.refreshManagedRegistrations();
  assert.equal(refreshed.refreshed, true);
  const saved = JSON.parse(await fs.readFile(path.join(dataRoot, ...configPath), "utf8"));
  assert.equal(Object.hasOwn(saved, "followUpPrompt"), false);
  assert.equal(saved.contactPrompt, "保持自然。");
  assert.equal(saved.autoMaintain, false);
  assert.deepEqual(saved.enabledContactIds, ["contact-existing"]);
});

test("an Agent Core bridge capability keeps its installed contacts in the existing product config", async () => {
  const root = await temporaryDirectory("suzu-capability-agent-core-contact-");
  const dataRoot = path.join(root, "software-data");
  const projectRoot = path.join(root, "contact");
  const contactId = "contact-image-vision";
  await Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(projectRoot)]);
  const synchronized = [];
  const service = createCapabilitiesService({
    capabilityRuntime: {
      sync: async ({ capabilityId, contactEnabled, contactId: id }) => synchronized.push({ capabilityId, contactEnabled, contactId: id }),
      removeContact: async () => undefined,
    },
    contactProjectsService: {
      snapshot: async () => ({ contacts: [{ id: contactId, name: "Suzu", projectRoot }] }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  const enabled = await service.saveSettings({ id: "image-vision", value: { contactId, contactEnabled: true } });
  assert.equal(enabled.capabilities.find((item) => item.id === "image-vision")?.enabled, true);
  const configPath = path.join(dataRoot, "capabilities", "image-vision", "config.json");
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    enabledContactIds: [contactId],
    knownContactIds: [contactId],
  });
  await service.saveSettings({ id: "image-vision", value: { contactId, contactEnabled: false } });
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    enabledContactIds: [],
    knownContactIds: [contactId],
  });
  assert.deepEqual(synchronized, [
    { capabilityId: "image-vision", contactEnabled: true, contactId },
    { capabilityId: "image-vision", contactEnabled: false, contactId },
  ]);
});

test("Agent Core time awareness stays outside the contact capability catalog", async () => {
  const dataRoot = await temporaryDirectory("suzu-capability-time-hook-refresh-");
  const service = createCapabilitiesService({
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  assert.equal(service.snapshot().capabilities.some((capability) => capability.id === "time-awareness"), false);
});
