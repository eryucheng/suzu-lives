import assert from "node:assert/strict";
import test from "node:test";

import { sortSystemStatusItems, sortSystemStatusSections } from "../src/react/system-status-order.mjs";

test("system status puts attention items before missing and healthy items", () => {
  const items = [
    { id: "healthy", state: "ok" },
    { id: "external", state: "notice" },
    { id: "missing", state: "missing" },
    { id: "warning", state: "warning" },
    { id: "error", state: "error" },
  ];

  assert.deepEqual(sortSystemStatusItems(items).map((item) => item.id), ["error", "warning", "external", "missing", "healthy"]);
});

test("system status puts sections with the most serious item first", () => {
  const sections = [
    { id: "healthy", items: [{ id: "healthy-item", state: "ok" }] },
    { id: "warning", items: [{ id: "healthy-item", state: "ok" }, { id: "warning-item", state: "warning" }] },
    { id: "error", items: [{ id: "error-item", state: "error" }] },
  ];

  const sorted = sortSystemStatusSections(sections);
  assert.deepEqual(sorted.map((section) => section.id), ["error", "warning", "healthy"]);
  assert.deepEqual(sorted[1].items.map((item) => item.id), ["warning-item", "healthy-item"]);
});
