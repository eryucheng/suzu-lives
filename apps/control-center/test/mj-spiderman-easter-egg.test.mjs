import assert from "node:assert/strict";
import test from "node:test";

import {
  createMjSequenceMatcher,
  installMjSequenceListener,
} from "../../../easter-eggs/mj-spiderman/trigger.mjs";

test("mj matcher triggers immediately for adjacent lowercase or uppercase letters", () => {
  let now = 100;
  const matcher = createMjSequenceMatcher({ clock: () => now });

  assert.equal(matcher.feed({ key: "m" }), false);
  now += 120;
  assert.equal(matcher.feed({ key: "j" }), true);

  now += 100;
  assert.equal(matcher.feed({ key: "M" }), false);
  now += 80;
  assert.equal(matcher.feed({ key: "J" }), true);
});

test("mj matcher rejects stale, interrupted, modified, repeated, and composing input", () => {
  let now = 0;
  const matcher = createMjSequenceMatcher({ clock: () => now, maxIntervalMs: 500 });

  matcher.feed({ key: "m" });
  now = 501;
  assert.equal(matcher.feed({ key: "j" }), false);

  matcher.feed({ key: "m" });
  assert.equal(matcher.feed({ key: "Backspace" }), false);
  assert.equal(matcher.feed({ key: "j" }), false);

  matcher.feed({ key: "m" });
  assert.equal(matcher.feed({ ctrlKey: true, key: "j" }), false);

  matcher.feed({ key: "m" });
  assert.equal(matcher.feed({ isComposing: true, key: "j" }), false);

  matcher.feed({ key: "m" });
  assert.equal(matcher.feed({ key: "j", repeat: true }), false);
  assert.equal(matcher.feed({ key: "j" }), true);
});

test("mj matcher permits Shift between the two uppercase letters", () => {
  let now = 20;
  const matcher = createMjSequenceMatcher({ clock: () => now });

  matcher.feed({ key: "M", shiftKey: true });
  now += 30;
  matcher.feed({ key: "Shift", shiftKey: true });
  now += 30;
  assert.equal(matcher.feed({ key: "J", shiftKey: true }), true);
});

test("installed listener captures keydown anywhere and removes every listener on cleanup", () => {
  const listeners = new Map();
  const calls = [];
  const target = {
    addEventListener(type, listener, capture = false) {
      listeners.set(type, { capture, listener });
    },
    removeEventListener(type, listener, capture = false) {
      const registered = listeners.get(type);
      if (registered?.listener === listener && registered.capture === capture) listeners.delete(type);
    },
  };

  const uninstall = installMjSequenceListener({
    onTrigger: (event) => calls.push(event.target),
    target,
  });

  assert.equal(listeners.get("keydown")?.capture, true);
  listeners.get("keydown").listener({ key: "m", target: "text-field" });
  listeners.get("keydown").listener({ key: "j", target: "dialog-button" });
  assert.deepEqual(calls, ["dialog-button"]);

  uninstall();
  assert.equal(listeners.size, 0);
});
