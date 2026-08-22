import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CALENDAR_ROOT = resolve(APP_ROOT, "..", "..", "packages", "design-system", "src", "components", "Calendar");

test("calendar markers reserve symmetric rails so marked and unmarked dates share a baseline", () => {
  const component = readFileSync(resolve(CALENDAR_ROOT, "Calendar.tsx"), "utf8");
  const styles = readFileSync(resolve(CALENDAR_ROOT, "Calendar.module.css"), "utf8");

  assert.match(component, /hasDots && styles\.dayWithDots/u);
  assert.match(component, /className=\{styles\.dayNumber\}/u);
  assert.match(styles, /\.dayWithDots\s*\{[\s\S]*?grid-template-rows:\s*var\(--calendar-marker-reserve\) minmax\(0, 1fr\) var\(--calendar-marker-reserve\);/u);
  assert.match(styles, /\.dayWithDots \.dayNumber\s*\{[\s\S]*?grid-row:\s*2;[\s\S]*?align-self:\s*center;/u);
  assert.match(styles, /\.dots\s*\{[\s\S]*?grid-row:\s*3;/u);
  assert.doesNotMatch(styles, /\.dots\s*\{[^}]*position:\s*absolute/u);
});

test("calendar offers a compact layout without changing fill layout semantics", () => {
  const component = readFileSync(resolve(CALENDAR_ROOT, "Calendar.tsx"), "utf8");
  const styles = readFileSync(resolve(CALENDAR_ROOT, "Calendar.module.css"), "utf8");

  assert.match(component, /export type CalendarLayout = 'content' \| 'compact' \| 'fill';/u);
  assert.match(component, /layout === 'compact' && styles\['layout-compact'\]/u);
  assert.match(component, /layout === 'compact' && styles\['grid-compact'\]/u);
  assert.match(styles, /\.grid-compact\s*\{[\s\S]*?grid-auto-rows:\s*var\(--calendar-compact-row-height\);/u);
  assert.match(styles, /\.grid-fill\s*\{[\s\S]*?flex:\s*1;/u);
});

test("hovered and selected dates share one full calendar-cell frame", () => {
  const styles = readFileSync(resolve(CALENDAR_ROOT, "Calendar.module.css"), "utf8");

  assert.match(styles, /\.day:hover,\s*\.day\.selected,\s*\.day\.daySelected\s*\{[\s\S]*?align-self:\s*stretch;[\s\S]*?justify-self:\s*stretch;/u);
  assert.doesNotMatch(styles, /--calendar-day-frame-(?:inline|block)-size/u);
});

test("calendar month title is top-aligned when its controls are taller", () => {
  const styles = readFileSync(resolve(CALENDAR_ROOT, "Calendar.module.css"), "utf8");

  assert.match(styles, /\.head\s*\{[\s\S]*?align-items:\s*flex-start;/u);
});
