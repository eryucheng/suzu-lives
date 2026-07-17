import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_HOOK_PATH = path.join(
  HERE,
  "..",
  "scripts",
  "hooks",
  "time-awareness",
  "timehook.mjs",
);
const HOOK_PATH = fs.existsSync(REPOSITORY_HOOK_PATH)
  ? REPOSITORY_HOOK_PATH
  : path.join(HERE, "time-awareness", "timehook.mjs");

function expectedContext(date) {
  const weekdays = [
    "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六",
  ];
  return `你知道现在是${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}。\n`;
}

test("时间 Hook 输出当前本地分钟的 UserPromptSubmit additionalContext", () => {
  const before = new Date();
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    encoding: "utf8",
    windowsHide: true,
  });
  const after = new Date();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput?.hookEventName, "UserPromptSubmit");

  const possibleContexts = new Set([expectedContext(before), expectedContext(after)]);
  assert.ok(
    possibleContexts.has(payload.hookSpecificOutput?.additionalContext),
    `unexpected context: ${payload.hookSpecificOutput?.additionalContext}`,
  );
});

test("时间 Hook 合并法定节假日和私人日期", (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-time-awareness-"));
  t.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));

  const temporaryHook = path.join(temporaryDirectory, "timehook.mjs");
  fs.copyFileSync(HOOK_PATH, temporaryHook);

  const now = new Date();
  const monthDay = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const exactDate = `${now.getFullYear()}-${monthDay}`;
  fs.writeFileSync(path.join(temporaryDirectory, "holidays.json"), JSON.stringify({
    events: [
      { date: monthDay, name: "循环事项", type: "纪念日" },
    ],
  }), "utf8");
  fs.writeFileSync(path.join(temporaryDirectory, "calendar.local.json"), JSON.stringify({
    events: [
      { date: exactDate, name: "一次事项", type: "日程" },
      { date: monthDay, name: "停用事项", enabled: false },
    ],
  }), "utf8");

  const result = spawnSync(process.execPath, [temporaryHook], {
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext;
  assert.match(context, /今天是循环事项，也是一次事项。/);
  assert.doesNotMatch(context, /停用事项/);
  assert.doesNotMatch(context, /纪念日|日程/);

  fs.writeFileSync(path.join(temporaryDirectory, "calendar.local.json"), "{格式错误", "utf8");
  const brokenLocalResult = spawnSync(process.execPath, [temporaryHook], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(brokenLocalResult.status, 0, brokenLocalResult.stderr);
  const fallbackContext = JSON.parse(brokenLocalResult.stdout).hookSpecificOutput?.additionalContext;
  assert.match(fallbackContext, /今天是循环事项。/);
});
