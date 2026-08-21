import assert from "node:assert/strict";
import test from "node:test";

import { publicCalendarEvents } from "../electron/services/public-calendar-events.mjs";

function hasEvent(events, date, name, type) {
  return events.some((event) => event.date === date && event.name === name && (!type || event.type === type));
}

test("public calendar derives Chinese lunar festivals and solar terms for the requested year", () => {
  const events = publicCalendarEvents({ year: 2026 });

  assert.ok(hasEvent(events, "2026-02-16", "除夕", "法定节日"));
  assert.ok(hasEvent(events, "2026-02-17", "春节", "法定节日"));
  assert.ok(hasEvent(events, "2026-08-19", "七夕节", "传统节日"));
  assert.ok(hasEvent(events, "2026-09-25", "中秋节", "法定节日"));
  assert.ok(hasEvent(events, "2026-04-05", "清明", "二十四节气"));
});

test("public calendar keeps lunar dates correct when browsing another year", () => {
  const events = publicCalendarEvents({ year: 2027 });

  assert.ok(hasEvent(events, "2027-02-05", "除夕", "法定节日"));
  assert.ok(hasEvent(events, "2027-02-06", "春节", "法定节日"));
  assert.ok(hasEvent(events, "2027-08-08", "七夕节", "传统节日"));
});
