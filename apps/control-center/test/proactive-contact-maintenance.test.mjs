import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScheduleTask, listScheduleTasks, setScheduleTaskEnabled } from "@suzu-lives/task-scheduler";
import {
  maintainProactiveContactChains,
  PROACTIVE_CHAIN_DESCRIPTION,
} from "../electron/services/proactive-contact-maintenance.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("automatic proactive maintenance restores one missing chain per enabled contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-");
  const now = new Date("2026-08-10T10:00:00+08:00");
  const settings = {
    autoMaintain: true,
    chainPrompt: "根据时间自然联系，并设置下一次任务。",
    enabledContactIds: ["contact-first", "contact-second"],
  };

  const created = await maintainProactiveContactChains({ dataRoot, now, settings });
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((task) => ({
    description: task.description,
    dueAt: task.dueAt,
    prompt: task.target.prompt,
    source: task.source,
  })), [
    {
      description: PROACTIVE_CHAIN_DESCRIPTION,
      dueAt: "2026-08-10T02:01:00.000Z",
      prompt: settings.chainPrompt,
      source: "agent",
    },
    {
      description: PROACTIVE_CHAIN_DESCRIPTION,
      dueAt: "2026-08-10T02:01:00.000Z",
      prompt: settings.chainPrompt,
      source: "agent",
    },
  ]);
  assert.equal((await maintainProactiveContactChains({ dataRoot, now, settings })).length, 0);

  await setScheduleTaskEnabled({ dataRoot, id: created[0].id, enabled: false });
  const restored = await maintainProactiveContactChains({ dataRoot, now, settings });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, "contact-first");
  assert.equal((await listScheduleTasks({ dataRoot })).filter((task) => task.enabled && task.description === PROACTIVE_CHAIN_DESCRIPTION).length, 2);
});

test("automatic proactive maintenance stays idle when the switch is off", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-off-");
  const settings = {
    autoMaintain: false,
    chainPrompt: "不会创建",
    enabledContactIds: ["contact-off"],
  };
  await createScheduleTask({
    dataRoot,
    delay: "5m",
    prompt: "临时回访",
    contactId: "contact-off",
    description: "临时回访",
  });

  assert.deepEqual(await maintainProactiveContactChains({ dataRoot, settings }), []);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
});

test("a targeted maintenance check only follows its own contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-targeted-");
  const target = { contactId: "contact-running" };
  const otherTarget = { contactId: "contact-other" };
  const settings = {
    autoMaintain: true,
    chainPrompt: "继续链式主动关心。",
    enabledContactIds: [target.contactId, otherTarget.contactId],
  };

  const restored = await maintainProactiveContactChains({ dataRoot, scope: target, settings });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, target.contactId);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
});
