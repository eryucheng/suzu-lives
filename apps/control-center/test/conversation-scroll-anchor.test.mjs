import assert from "node:assert/strict";
import test from "node:test";

import {
  captureConversationViewportAnchor,
  restoreConversationViewportAnchor,
} from "../src/react/conversation-scroll-anchor.mjs";

function fakeList({ clientHeight = 200, offsets = {}, scrollHeight = 1_000, scrollTop = 0 } = {}) {
  const list = {
    clientHeight,
    scrollHeight,
    scrollTop,
    getBoundingClientRect: () => ({ bottom: 300, top: 100 }),
  };
  const nodes = Object.keys(offsets).map((id) => ({
    dataset: { conversationAnchorId: id },
    getBoundingClientRect: () => ({
      bottom: 100 + Number(offsets[id]) - list.scrollTop + 50,
      top: 100 + Number(offsets[id]) - list.scrollTop,
    }),
  }));
  list.querySelectorAll = () => nodes;
  return { list, offsets };
}

test("conversation viewport anchor preserves the visible message after rows above it change", () => {
  const fixture = fakeList({ offsets: { system: 280, user: 380, assistant: 520 }, scrollTop: 300 });
  const anchor = captureConversationViewportAnchor(fixture.list);
  assert.deepEqual(anchor, {
    anchors: [
      { anchorId: "system", offset: -20 },
      { anchorId: "user", offset: 80 },
    ],
    mode: "messages",
  });

  // Opening another display category adds 220 px above the messages being read.
  fixture.offsets.system += 220;
  fixture.offsets.user += 220;
  fixture.offsets.assistant += 220;
  assert.equal(restoreConversationViewportAnchor(fixture.list, anchor), true);
  assert.equal(fixture.list.scrollTop, 520);
});

test("conversation viewport anchor falls back when its first visible row is hidden", () => {
  const fixture = fakeList({ offsets: { system: 280, user: 380 }, scrollTop: 300 });
  const anchor = captureConversationViewportAnchor(fixture.list);
  fixture.list.querySelectorAll = () => [{
    dataset: { conversationAnchorId: "user" },
    getBoundingClientRect: () => ({ bottom: 430 - fixture.list.scrollTop, top: 380 - fixture.list.scrollTop }),
  }];
  assert.equal(restoreConversationViewportAnchor(fixture.list, anchor), true);
  assert.equal(fixture.list.scrollTop, 200);
});

test("conversation viewport anchor keeps the viewer pinned to the bottom", () => {
  const fixture = fakeList({ scrollHeight: 1_000, scrollTop: 800 });
  const anchor = captureConversationViewportAnchor(fixture.list);
  assert.deepEqual(anchor, { mode: "bottom" });
  fixture.list.scrollHeight = 1_260;
  assert.equal(restoreConversationViewportAnchor(fixture.list, anchor), true);
  assert.equal(fixture.list.scrollTop, 1_060);
});
