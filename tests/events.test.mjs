import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeGeneratedEvents,
  prepareEventAppend,
  readEvents,
} from "../memory/rag/events.mjs";

const archivedMessages = [
  {
    id: "user-1:user_text:0",
    memory_ref: "M0001",
    source_uuid: "user-1",
    timestamp: "2026-07-01T08:00:00+08:00",
    role: "user",
    text: "周六一起去看海。",
  },
  {
    id: "assistant-1:assistant_text:0",
    memory_ref: "M0002",
    source_uuid: "assistant-1",
    timestamp: "2026-07-01T08:00:05+08:00",
    role: "assistant",
    text: "好，我会带上蓝色保温杯。",
  },
];

test("有效事件会分别保存真实发生日期和来源消息时间", () => {
  const events = normalizeGeneratedEvents([
    {
      title: "周六看海",
      text: "我们约好周六一起去看海，我答应带蓝色保温杯。",
      event_date: "2026-07-04",
      status: "ongoing",
      source_refs: ["M0001", "[M0002]"],
    },
  ], archivedMessages, { compactionBatchUuid: "batch-1" });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].source_ids, ["user-1:user_text:0", "assistant-1:assistant_text:0"]);
  assert.deepEqual(events[0].source_uuids, ["user-1", "assistant-1"]);
  assert.equal(events[0].event_date, "2026-07-04");
  assert.equal(events[0].source_start_timestamp, "2026-07-01T00:00:00.000Z");
  assert.equal(events[0].source_end_timestamp, "2026-07-01T00:00:05.000Z");
  assert.equal(events[0].memory_type, "event");
  assert.equal(events[0].generator_version, 2);
});

test("事件日期未知时保存 null，非法日期会被拒绝", () => {
  const unknown = normalizeGeneratedEvents([{
    text: "我们约好以后一起去看海。",
    event_date: "unknown",
    status: "ongoing",
    source_refs: ["M0001"],
  }], archivedMessages, { compactionBatchUuid: "batch-unknown" });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].event_date, null);

  const invalid = normalizeGeneratedEvents([{
    text: "日期是模型乱写的。",
    event_date: "2026-02-30",
    status: "unknown",
    source_refs: ["M0001"],
  }], archivedMessages, { compactionBatchUuid: "batch-invalid" });
  assert.deepEqual(invalid, []);
});

test("未知引用、空事件和无来源事件都会被拒绝", () => {
  const events = normalizeGeneratedEvents([
    { text: "模型编造的事件", event_date: "unknown", source_refs: ["M9999"] },
    { text: "", event_date: "unknown", source_refs: ["M0001"] },
    { text: "没有证据的事件", event_date: "unknown", source_refs: [] },
    { text: "混入未知证据", event_date: "unknown", source_refs: ["M0001", "M9999"] },
    { text: "没有显式日期字段", source_refs: ["M0001"] },
  ], archivedMessages, { compactionBatchUuid: "batch-1" });
  assert.deepEqual(events, []);
});

test("相同内容和来源生成稳定 id，批次号不影响 id", () => {
  const candidate = {
    text: "我们约好周六一起去看海。",
    event_date: "2026-07-04",
    status: "ongoing",
    source_refs: ["M0001", "M0002"],
  };
  const first = normalizeGeneratedEvents([candidate], archivedMessages, {
    compactionBatchUuid: "batch-1",
  })[0];
  const second = normalizeGeneratedEvents([candidate], archivedMessages, {
    compactionBatchUuid: "batch-2",
  })[0];
  assert.equal(first.id, second.id);
  assert.match(first.id, /^event:[a-f0-9]{64}$/u);

  const reversed = normalizeGeneratedEvents([{
    ...candidate,
    source_refs: ["M0002", "M0001"],
  }], archivedMessages, { compactionBatchUuid: "batch-3" })[0];
  assert.equal(first.id, reversed.id);
});

test("重复提交不会重复追加事件", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-lives-events-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const eventsPath = path.join(directory, "events.jsonl");
  const events = normalizeGeneratedEvents([{
    text: "我们约好周六一起去看海。",
    event_date: "2026-07-04",
    status: "ongoing",
    source_refs: ["M0001", "M0002"],
  }], archivedMessages, { compactionBatchUuid: "batch-1" });

  assert.equal(prepareEventAppend(events, eventsPath).commit().added, 1);
  assert.equal(prepareEventAppend(events, eventsPath).commit().added, 0);
  assert.equal(readEvents(eventsPath).length, 1);
});
