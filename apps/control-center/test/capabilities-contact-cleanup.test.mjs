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

test("removing a contact clears it from every contact-scoped capability config", async () => {
  const dataRoot = await temporaryDirectory("suzu-capability-contact-cleanup-");
  const removedId = "contact-delete-me";
  const retainedId = "contact-keep-me";
  const paths = [
    ["capabilities", "time-awareness", "config.json"],
    ["automation", "proactive-contact", "config.json"],
    ["automation", "iphone-bridge", "config.json"],
    ["capabilities", "image-vision", "config.json"],
  ];
  for (const segments of paths) {
    await writeConfig(dataRoot, segments, {
      enabledContactIds: [removedId, retainedId],
      knownContactIds: [retainedId, removedId],
      untouched: true,
    });
  }
  let iphoneNotifications = 0;
  const service = createCapabilitiesService({
    onIphoneFeedbackChange: () => { iphoneNotifications += 1; },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  const result = await service.removeContact({ contactId: removedId });
  assert.equal(result.updated, paths.length);
  assert.equal(iphoneNotifications, 1);
  for (const segments of paths) {
    const saved = JSON.parse(await fs.readFile(path.join(dataRoot, ...segments), "utf8"));
    assert.deepEqual(saved.enabledContactIds, [retainedId]);
    assert.deepEqual(saved.knownContactIds, [retainedId]);
    assert.equal(saved.untouched, true);
  }
});

test("voice-call registration is added for existing and newly created contacts", async () => {
  const root = await temporaryDirectory("suzu-capability-voice-call-");
  const dataRoot = path.join(root, "software-data");
  const existingProject = path.join(root, "existing-contact");
  const newProject = path.join(root, "new-contact");
  await Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(existingProject), fs.mkdir(newProject)]);
  const service = createCapabilitiesService({
    contactProjectsService: {
      snapshot: async () => ({ contacts: [{ id: "contact-existing", projectRoot: existingProject }] }),
    },
    launcherCommand: "suzu-lives",
    settingsService: {
      load: () => ({ dataRoot, projectRoot: existingProject }),
      response: () => ({ dataRoot }),
    },
  });

  const refreshed = await service.refreshManagedRegistrations();
  assert.equal(refreshed.errors.length, 0);
  const existingSkill = await fs.readFile(path.join(existingProject, ".claude", "skills", "voice-call", "SKILL.md"), "utf8");
  assert.match(existingSkill, /suzu-lives:ability:voice-call/u);

  const initialized = await service.initializeDefaultContactCapabilities({ id: "contact-new", projectRoot: newProject });
  assert.equal(initialized.errors.length, 0);
  const newSkill = await fs.readFile(path.join(newProject, ".claude", "skills", "voice-call", "SKILL.md"), "utf8");
  assert.match(newSkill, /capability voice-call request/u);
});

test("registration refresh replaces the old time Hook for enabled contacts", async () => {
  const root = await temporaryDirectory("suzu-capability-time-hook-refresh-");
  const dataRoot = path.join(root, "software-data");
  const contactProject = path.join(root, "time-contact");
  const contactId = "contact-time";
  await Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(contactProject)]);
  await writeConfig(dataRoot, ["capabilities", "time-awareness", "config.json"], {
    enabledContactIds: [contactId],
  });
  const installedProjects = [];
  const service = createCapabilitiesService({
    contactProjectsService: {
      snapshot: async () => ({ contacts: [{ id: contactId, projectRoot: contactProject }] }),
    },
    launcherCommand: "suzu-lives",
    projectHooksService: {
      installTimeAwareness: async ({ projectRoot }) => { installedProjects.push(projectRoot); },
      uninstallTimeAwareness: async () => undefined,
    },
    settingsService: {
      load: () => ({ dataRoot, projectRoot: contactProject }),
      response: () => ({ dataRoot }),
    },
  });

  const refreshed = await service.refreshManagedRegistrations();
  assert.equal(refreshed.errors.length, 0);
  assert.deepEqual(installedProjects, [contactProject]);
});
