import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  resolveAgentConversationDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import {
  createTimeAwarenessContextHook,
  DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES,
  TIME_AWARENESS_HOOK_MOUNT,
} from "../electron/services/time-awareness-hook.mjs";

async function temporaryDirectory(prefix) {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("time awareness declares its dynamic lifecycle mount separately from its context block", () => {
  assert.deepEqual(TIME_AWARENESS_HOOK_MOUNT, {
    id: "time-awareness",
    lifecycleEvent: "DynamicContextCollect",
    order: -100,
    policy: "observe",
    timeoutMs: 3_000,
  });
});

test("DSH time awareness injects once per enabled contact session and preserves the 10-minute default", async () => {
  const root = await temporaryDirectory("suzu-lives-dsh-time-awareness-");
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const contactId = "contact-suzu";
  const sessionId = "session-suzu";
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJson(path.join(dataRoot, "capabilities", "time-awareness", "config.json"), {
    enabledContactIds: [contactId],
  });
  const agentId = stableAgentId(projectRoot);
  await writeJson(path.join(dataRoot, "calendar", "calendar.local.json"), {
    events: [{ agentId, date: "10-01", name: "纪念日" }],
  });

  let current = new Date(2026, 9, 1, 9, 0, 0);
  const hook = createTimeAwarenessContextHook({ dataRoot, now: () => current });
  const payload = { contactId, projectRoot, sessionId };

  const first = await hook.collect(payload);
  assert.equal(first?.kind, "time-awareness");
  assert.deepEqual(first?.display, { category: "time", context: true, label: "时间感知", transcript: false });
  assert.equal(first?.metadata?.intervalMinutes, DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES);
  assert.match(first?.text || "", /10月1日/u);
  assert.match(first?.text || "", /09:00/u);
  assert.match(first?.text || "", /国庆节/u);
  assert.match(first?.text || "", /纪念日/u);
  assert.equal(await hook.collect(payload), null);

  current = new Date(2026, 9, 1, 9, 10, 0);
  assert.equal(await hook.collect(payload), null);
  current = new Date(2026, 9, 1, 9, 10, 1);
  assert.ok(await hook.collect(payload));

  const otherSession = await hook.collect({ ...payload, sessionId: "session-second" });
  assert.ok(otherSession, "每个 DSH 会话有独立的时间提醒间隔");
  const state = JSON.parse(await fs.readFile(path.join(resolveAgentConversationDataRoot({
    dataRoot,
    agentId,
    projectRoot,
    sessionId,
  }), "time-awareness.json"), "utf8"));
  assert.equal(state.lastInjectedAt, current.toISOString());
});

test("DSH time awareness never injects for a contact that has not enabled it", async () => {
  const root = await temporaryDirectory("suzu-lives-dsh-time-awareness-disabled-");
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJson(path.join(dataRoot, "capabilities", "time-awareness", "config.json"), {
    intervalMinutes: 1,
    enabledContactIds: ["contact-other"],
  });
  const hook = createTimeAwarenessContextHook({
    dataRoot,
    now: () => new Date(2026, 0, 2, 12, 0, 0),
  });

  const value = await hook.collect({
    contactId: "contact-suzu",
    projectRoot,
    sessionId: "session-suzu",
  });
  assert.equal(value, null);
});
