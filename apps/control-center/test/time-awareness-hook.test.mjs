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
  ensureTimeAwarenessConfig,
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

test("time awareness persists the application time zone once and preserves that choice", async () => {
  const root = await temporaryDirectory("suzu-lives-time-zone-config-");
  const dataRoot = path.join(root, "data");
  const first = await ensureTimeAwarenessConfig({
    dataRoot,
    detectTimeZone: () => "Asia/Shanghai",
  });
  let repeatedDetectionCalls = 0;
  const second = await ensureTimeAwarenessConfig({
    dataRoot,
    detectTimeZone: () => {
      repeatedDetectionCalls += 1;
      return "America/Los_Angeles";
    },
  });
  const saved = JSON.parse(await fs.readFile(path.join(dataRoot, "capabilities", "time-awareness", "config.json"), "utf8"));

  assert.equal(first.timeZone, "Asia/Shanghai");
  assert.equal(second.timeZone, "Asia/Shanghai");
  assert.equal(saved.timeZone, "Asia/Shanghai");
  assert.equal(repeatedDetectionCalls, 0);
});

test("time awareness refreshes the clock at the configured interval and presents day notices every six hours", async () => {
  const root = await temporaryDirectory("suzu-lives-dsh-time-awareness-");
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const contactId = "contact-suzu";
  const sessionId = "session-suzu";
  await fs.mkdir(projectRoot, { recursive: true });
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
  assert.match(first?.text || "", /你知道现在是/u);
  assert.doesNotMatch(first?.text || "", /本机时区|UTC[+-]\d{2}:\d{2}/u);
  assert.match(first?.text || "", /国庆节/u);
  assert.match(first?.text || "", /纪念日/u);
  const config = JSON.parse(await fs.readFile(path.join(dataRoot, "capabilities", "time-awareness", "config.json"), "utf8"));
  assert.ok(config.timeZone);
  assert.equal(await hook.collect(payload), null);

  current = new Date(2026, 9, 1, 9, 10, 0);
  assert.equal(await hook.collect(payload), null);
  current = new Date(2026, 9, 1, 9, 10, 1);
  const clockRefresh = await hook.collect(payload);
  assert.match(clockRefresh?.text || "", /09:10/u);
  assert.doesNotMatch(clockRefresh?.text || "", /国庆节|纪念日/u);
  assert.equal(clockRefresh?.metadata?.dayNotice, undefined);

  current = new Date(2026, 9, 1, 15, 0, 0);
  const dayNoticeRefresh = await hook.collect(payload);
  assert.match(dayNoticeRefresh?.text || "", /15:00/u);
  assert.match(dayNoticeRefresh?.text || "", /国庆节/u);
  assert.match(dayNoticeRefresh?.text || "", /纪念日/u);
  assert.equal(dayNoticeRefresh?.metadata?.dayNotice, true);

  const otherSession = await hook.collect({ ...payload, sessionId: "session-second" });
  assert.ok(otherSession, "每个会话维护独立的时间提醒间隔");
  const state = JSON.parse(await fs.readFile(path.join(resolveAgentConversationDataRoot({
    dataRoot,
    agentId,
    projectRoot,
    sessionId,
  }), "time-awareness.json"), "utf8"));
  assert.equal(state.lastInjectedAt, current.toISOString());
  assert.equal(state.lastDayNoticeAt, current.toISOString());
  assert.equal(state.lastDayNoticeDate, "2026-10-01");
});

test("time awareness presents a new calendar day's notice on its first eligible refresh", async () => {
  const root = await temporaryDirectory("suzu-lives-time-awareness-day-change-");
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const contactId = "contact-suzu";
  const sessionId = "session-suzu";
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJson(path.join(dataRoot, "calendar", "calendar.local.json"), {
    events: [{ agentId: stableAgentId(projectRoot), date: "10-02", name: "纪念日" }],
  });

  let current = new Date(2026, 9, 1, 23, 55, 0);
  const hook = createTimeAwarenessContextHook({ dataRoot, now: () => current });
  const payload = { contactId, projectRoot, sessionId };
  assert.match((await hook.collect(payload))?.text || "", /国庆节/u);

  current = new Date(2026, 9, 2, 0, 5, 1);
  const nextDay = await hook.collect(payload);
  assert.match(nextDay?.text || "", /10月2日/u);
  assert.match(nextDay?.text || "", /纪念日/u);
  assert.equal(nextDay?.metadata?.dayNotice, true);
});

test("time awareness supplies a fresh clock at an automatic task opening", async () => {
  const root = await temporaryDirectory("suzu-lives-time-awareness-task-");
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });

  let current = new Date(2026, 7, 23, 9, 0, 0);
  const hook = createTimeAwarenessContextHook({ dataRoot, now: () => current });
  const payload = {
    contactId: "contact-suzu",
    projectRoot,
    sessionId: "session-suzu",
  };
  assert.match((await hook.collect(payload))?.text || "", /09:00/u);

  current = new Date(2026, 7, 23, 9, 1, 0);
  const proactiveOpening = await hook.collect({
    ...payload,
    scheduleSource: "proactive-contact",
    taskContext: { id: "proactive-contact-1", text: "运行主动关心：判断此刻是否适合联系对方。" },
  });
  assert.match(proactiveOpening?.text || "", /09:01/u);
  assert.equal(proactiveOpening?.metadata?.trigger, "task");
});

test("time awareness ignores legacy contact scope and remains available to every contact", async () => {
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
  assert.equal(value?.kind, "time-awareness");
  assert.equal(value?.metadata?.intervalMinutes, 1);
});
