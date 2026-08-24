import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { releasePointerCapture, subscribePointerCaptureRecovery } from "../src/core/pointer-capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    emit(type) {
      listeners.get(type)?.();
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

test("pointer capture recovery aborts stale drags when the window loses focus", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fakeWindow = eventTarget();
  const fakeDocument = { ...eventTarget(), visibilityState: "visible" };
  let recovered = 0;

  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow, writable: true });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument, writable: true });
  try {
    const unsubscribe = subscribePointerCaptureRecovery(() => { recovered += 1; });

    fakeWindow.emit("blur");
    fakeDocument.emit("visibilitychange");
    fakeDocument.visibilityState = "hidden";
    fakeDocument.emit("visibilitychange");
    unsubscribe();
    fakeWindow.emit("blur");

    assert.equal(recovered, 2);
  } finally {
    restoreGlobal("window", windowDescriptor);
    restoreGlobal("document", documentDescriptor);
  }
});

test("pointer capture release is safe when the platform has already ended the drag", () => {
  const released = [];
  const target = {
    hasPointerCapture(pointerId) {
      return pointerId === 8;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    },
  };

  releasePointerCapture(target, 8);
  releasePointerCapture(target, 9);
  releasePointerCapture(null, 8);

  assert.deepEqual(released, [8]);
});

test("every pointer-capture drag path has both local and window-level recovery", () => {
  const source = (...parts) => readFileSync(resolve(HERE, "..", "src", ...parts), "utf8");
  const shell = source("react", "app-shell.jsx");
  const conversation = source("react", "conversation-page.jsx");
  const admin = source("react", "admin-page.jsx");
  const brain = source("features", "memory-brain", "brain-view.mjs");

  assert.match(shell, /usePointerCaptureRecovery\(abortSidebarResize\)/u);
  assert.match(shell, /onLostPointerCapture=\{cancelSidebarResize\}/u);
  assert.match(conversation, /usePointerCaptureRecovery\(\(\) => \{[\s\S]*?abortConversationScrollbarDrag\(\);[\s\S]*?abortRosterResize\(\);[\s\S]*?abortComposerResize\(\);/u);
  assert.match(conversation, /onLostPointerCapture=\{onResizePointerCaptureLost\}/u);
  assert.match(conversation, /onLostPointerCapture=\{cancelRosterResize\}/u);
  assert.match(conversation, /onLostPointerCapture=\{finishConversationScrollbarDrag\}/u);
  assert.match(conversation, /onLostPointerCapture=\{endDrag\}/u);
  assert.match(admin, /usePointerCaptureRecovery\(\(\) => finishDrag\(\)\)/u);
  assert.match(admin, /onLostPointerCapture=\{finishDrag\}/u);
  assert.match(brain, /subscribePointerCaptureRecovery\(\(\) => finishPointerInteraction\(\)\)/u);
  assert.match(brain, /addEventListener\("lostpointercapture", onPointerCaptureEnd\)/u);
});
