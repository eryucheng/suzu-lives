import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTodayCalendarService } from "../electron/services/today-calendar.mjs";

async function fixture() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-calendar-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-calendar-data-"));
  const settings = { projectRoot, dataRoot, agentId: "agent-calendar-fixture" };
  return {
    dataRoot,
    settings,
    service: createTodayCalendarService({ settingsService: { load: () => settings, response: () => ({ dataRoot }) } }),
  };
}

test("today calendar keeps public holidays and stores private events with legacy-compatible dates", async () => {
  const { dataRoot, settings, service } = await fixture();
  const initial = await service.snapshot();
  assert.equal(initial.status, "ready");
  assert.ok(initial.events.some((event) => event.name === "国庆节" && event.date === "10-01" && event.editable === false));
  assert.ok(initial.events.some((event) => event.name === "儿童节" && event.date === "06-01" && event.type === "公共节日"));
  assert.ok(initial.events.some((event) => event.name === "春节假期" && event.date === "2026-02-17" && event.type === "放假"));
  assert.ok(initial.events.some((event) => event.name === "春节" && event.date === "2027-02-06" && event.type === "法定节日"));

  const saved = await service.saveEvent({ name: "我们的纪念日", date: "2026-08-14", type: "纪念日", repeat: true, enabled: true });
  const event = saved.events.find((item) => item.name === "我们的纪念日");
  assert.equal(event.date, "08-14");
  assert.equal(event.editable, true);

  const filePath = path.join(dataRoot, "agents", settings.agentId, "time-awareness", "calendar.local.json");
  const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(stored.events.map((item) => ({ date: item.date, name: item.name, type: item.type, enabled: item.enabled })), [{ date: "08-14", name: "我们的纪念日", type: "纪念日", enabled: true }]);

  const paused = await service.saveEvent({ id: event.id, name: "我们的纪念日", date: "2026-08-14", type: "纪念日", repeat: false, enabled: false });
  assert.equal(paused.events.find((item) => item.id === event.id).date, "2026-08-14");
  assert.equal(paused.events.find((item) => item.id === event.id).enabled, false);

  const removed = await service.removeEvent(event.id);
  assert.equal(removed.events.some((item) => item.id === event.id), false);
});

test("today calendar never overwrites an unreadable private calendar", async () => {
  const { dataRoot, settings, service } = await fixture();
  const directory = path.join(dataRoot, "agents", settings.agentId, "time-awareness");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "calendar.local.json"), "{not valid json", "utf8");
  assert.equal((await service.snapshot()).status, "invalid");
  await assert.rejects(() => service.saveEvent({ name: "不覆盖", date: "2026-08-14", type: "纪念日", repeat: true, enabled: true }), /未覆盖原有内容/u);
});

test("today calendar requires a selected Agent before creating private events", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-calendar-data-"));
  const service = createTodayCalendarService({ settingsService: { load: () => ({ projectRoot: "", dataRoot, agentId: "" }), response: () => ({ dataRoot }) } });
  assert.equal((await service.snapshot()).status, "needs-agent");
  await assert.rejects(() => service.saveEvent({ name: "不保存", date: "2026-08-14", type: "纪念日" }), /请先选择/u);
});
