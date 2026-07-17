#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_PATHS = [
  path.join(HERE, "holidays.json"),
  path.join(HERE, "calendar.local.json"),
];
const weekdayNames = [
  "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六",
];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function readEventsFile(calendarPath) {
  if (!fs.existsSync(calendarPath)) return [];
  try {
    const raw = fs.readFileSync(calendarPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    // One broken local list must not block the conversation or the other list.
    return [];
  }
}

function readTodayEvents(now) {
  const exactDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const yearlyDate = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const results = [];
  const seen = new Set();

  for (const calendarPath of CALENDAR_PATHS) {
    for (const event of readEventsFile(calendarPath)) {
      if (!event || event.enabled === false) continue;

      const date = typeof event.date === "string" ? event.date.trim() : "";
      const name = typeof event.name === "string" ? event.name.trim() : "";
      if (!name || (date !== exactDate && date !== yearlyDate) || seen.has(name)) continue;

      seen.add(name);
      results.push(name);
    }
  }

  return results;
}

const now = new Date();
const localTime = `${now.getMonth() + 1}月${now.getDate()}日 ${weekdayNames[now.getDay()]} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
const todayEvents = readTodayEvents(now);
let calendarContext = "";
if (todayEvents.length === 1) {
  calendarContext = `今天是${todayEvents[0]}。`;
} else if (todayEvents.length > 1) {
  calendarContext = `今天是${todayEvents.slice(0, -1).join("、")}，也是${todayEvents.at(-1)}。`;
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `你知道现在是${localTime}。${calendarContext}\n`,
  },
}));
