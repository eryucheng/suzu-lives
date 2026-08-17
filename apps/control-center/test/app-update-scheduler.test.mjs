import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  scheduleAppUpdateChecks,
} from "../electron/services/app-update.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function timerFixture() {
  const timeouts = new Map();
  const intervals = new Map();
  const clearedTimeouts = [];
  const clearedIntervals = [];
  let nextId = 0;
  return {
    clearedIntervals,
    clearedTimeouts,
    intervals,
    setIntervalFn(callback, delay) {
      const id = ++nextId;
      intervals.set(id, { callback, delay });
      return id;
    },
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearIntervalFn(id) {
      clearedIntervals.push(id);
    },
    clearTimeoutFn(id) {
      clearedTimeouts.push(id);
    },
    timeouts,
  };
}

test("background update checks wait for startup, then repeat every twelve hours", () => {
  const timers = timerFixture();
  let checks = 0;
  const stop = scheduleAppUpdateChecks({
    checkForUpdates: () => { checks += 1; },
    ...timers,
  });

  assert.equal(checks, 0);
  const [[timeoutId, startupTimer]] = [...timers.timeouts.entries()];
  assert.equal(startupTimer.delay, APP_UPDATE_INITIAL_CHECK_DELAY_MS);

  startupTimer.callback();
  assert.equal(checks, 1);
  const [[intervalId, intervalTimer]] = [...timers.intervals.entries()];
  assert.equal(intervalTimer.delay, APP_UPDATE_CHECK_INTERVAL_MS);

  intervalTimer.callback();
  assert.equal(checks, 2);

  stop();
  assert.deepEqual(timers.clearedTimeouts, [timeoutId]);
  assert.deepEqual(timers.clearedIntervals, [intervalId]);
  intervalTimer.callback();
  assert.equal(checks, 2);
});

test("main process starts the background checker and disposes it before quitting", () => {
  const main = readFileSync(resolve(HERE, "..", "electron", "main.mjs"), "utf8");

  assert.match(main, /scheduleAppUpdateChecks\(\{[\s\S]*?checkForUpdates: \(\) => appUpdateService\.checkForUpdates\(\)/u);
  assert.match(main, /app\.once\("before-quit", stopAppUpdateChecks\)/u);
});
