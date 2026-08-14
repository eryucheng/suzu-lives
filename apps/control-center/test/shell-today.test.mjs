import assert from "node:assert/strict";
import test from "node:test";

import { renderShellView } from "../src/features/shell/index.mjs";

test("today page centers real dates and removes the old placeholder dashboard", () => {
  const view = renderShellView("today", {
    state: {
      data: {
        status: "ready",
        summary: { today: { amountCny: 8.5, requestCount: 2, knownRequestCount: 2, unknownRequestCount: 0 } },
        events: [{ feature: "视频分析", source: "视频理解", timestamp: "2026-08-14T08:30:00.000Z", amountCny: 1.2 }],
      },
      settings: null,
      todayMonth: "2026-08",
      todaySelectedDate: "2026-08-14",
      todayEventEditor: null,
      todayCalendar: {
        status: "ready",
        canEdit: true,
        events: [{ id: "event-fixture", date: "08-14", name: "我们的纪念日", type: "纪念日", enabled: true, source: "personal", editable: true }],
      },
    },
  });
  assert.match(view, />今天</);
  assert.match(view, /把重要的日子留在眼前。/);
  assert.match(view, /2026年8月/);
  assert.match(view, /我们的纪念日/);
  assert.match(view, /添加纪念日/);
  assert.match(view, /data-today-date="2026-08-14"/);
  assert.match(view, /todayEventDialog/);
  assert.doesNotMatch(view, /本地健康与成本/);
  assert.doesNotMatch(view, /需要你决定/);
  assert.doesNotMatch(view, /下一件事/);
  assert.match(view, /今日成本/);
  assert.match(view, /最近活动/);
  assert.match(view, /视频分析/);
  assert.match(view, /data-open-admin="usage"/);
  assert.doesNotMatch(view, /和 Suzu 一起，留出真正重要的时间/);
});
