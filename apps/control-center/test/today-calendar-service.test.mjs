import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTodayCalendarService } from "../electron/services/today-calendar.mjs";

async function fixture({ contacts = [
  { id: "contact-suzu", name: "Suzu", agentId: "agent-suzu" },
  { id: "contact-work", name: "工作", agentId: "agent-work" },
] } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-calendar-data-"));
  const settings = { dataRoot };
  const contactSnapshot = {
    status: "ready",
    contacts,
    activeContact: contacts[0] || null,
    preferredContact: contacts[0] || null,
  };
  return {
    contacts,
    dataRoot,
    service: createTodayCalendarService({
      contactProjectsService: { snapshot: async () => contactSnapshot },
      settingsService: { load: () => settings, response: () => ({ dataRoot }) },
    }),
  };
}

test("today calendar stores one global event list and labels each event with its contact", async () => {
  const { contacts, dataRoot, service } = await fixture();
  const initial = await service.snapshot();
  assert.equal(initial.status, "ready");
  assert.ok(initial.events.some((event) => event.name === "国庆节" && event.date === "10-01" && event.editable === false));
  assert.ok(initial.events.some((event) => event.name === "儿童节" && event.date === "06-01" && event.type === "公共节日"));
  assert.deepEqual(initial.contacts, [{ id: "contact-suzu", name: "Suzu" }, { id: "contact-work", name: "工作" }]);

  const first = await service.saveEvent({
    contactId: contacts[0].id,
    name: "Suzu 的生日",
    date: "2026-08-14",
    type: "生日",
    repeat: true,
    enabled: true,
  });
  const birthday = first.events.find((event) => event.name === "Suzu 的生日");
  assert.equal(birthday.date, "08-14");
  assert.equal(birthday.contactId, contacts[0].id);
  assert.equal(birthday.contactName, "Suzu");

  const combined = await service.saveEvent({
    contactId: contacts[1].id,
    name: "工作交付日",
    date: "2026-08-14",
    type: "日程",
    repeat: false,
    enabled: true,
  });
  const delivery = combined.events.find((event) => event.name === "工作交付日");
  assert.equal(delivery.contactId, contacts[1].id);
  assert.equal(delivery.contactName, "工作");

  const filePath = path.join(dataRoot, "calendar", "calendar.local.json");
  const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(stored.events.map((event) => ({ contactId: event.contactId, agentId: event.agentId, date: event.date, name: event.name, type: event.type, enabled: event.enabled })), [
    { contactId: "contact-suzu", agentId: "agent-suzu", date: "08-14", name: "Suzu 的生日", type: "生日", enabled: true },
    { contactId: "contact-work", agentId: "agent-work", date: "2026-08-14", name: "工作交付日", type: "日程", enabled: true },
  ]);

  const paused = await service.saveEvent({
    contactId: contacts[0].id,
    id: birthday.id,
    name: "Suzu 的生日",
    date: "2026-08-14",
    type: "生日",
    repeat: false,
    enabled: false,
  });
  assert.equal(paused.events.find((event) => event.id === birthday.id && event.contactId === contacts[0].id).date, "2026-08-14");
  assert.equal(paused.events.find((event) => event.id === birthday.id && event.contactId === contacts[0].id).enabled, false);

  const removed = await service.removeEvent({ contactId: contacts[0].id, id: birthday.id });
  assert.equal(removed.events.some((event) => event.id === birthday.id && event.contactId === contacts[0].id), false);
  assert.equal(removed.events.some((event) => event.id === delivery.id && event.contactId === contacts[1].id), true);
});

test("today calendar never overwrites an unreadable global calendar", async () => {
  const { contacts, dataRoot, service } = await fixture({ contacts: [{ id: "contact-suzu", name: "Suzu", agentId: "agent-suzu" }] });
  const directory = path.join(dataRoot, "calendar");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "calendar.local.json"), "{not valid json", "utf8");
  assert.equal((await service.snapshot()).status, "invalid");
  await assert.rejects(() => service.saveEvent({ contactId: contacts[0].id, name: "不覆盖", date: "2026-08-14", type: "纪念日", repeat: true, enabled: true }), /未覆盖原有内容/u);
});

test("today calendar requires a current contact before creating personal events", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-calendar-data-"));
  const service = createTodayCalendarService({
    contactProjectsService: { snapshot: async () => ({ status: "needs-root", contacts: [], activeContact: null, preferredContact: null }) },
    settingsService: { load: () => ({ dataRoot }), response: () => ({ dataRoot }) },
  });
  assert.equal((await service.snapshot()).status, "needs-agent");
  await assert.rejects(() => service.saveEvent({ contactId: "contact-missing", name: "不保存", date: "2026-08-14", type: "纪念日" }), /所选联系人/u);
});
