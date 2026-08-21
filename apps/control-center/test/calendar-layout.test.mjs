import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CALENDAR_ROOT = resolve(APP_ROOT, "..", "..", "packages", "design-system", "src", "components", "Calendar");

test("calendar markers reserve their own layout row instead of overlaying the day number", () => {
  const component = readFileSync(resolve(CALENDAR_ROOT, "Calendar.tsx"), "utf8");
  const styles = readFileSync(resolve(CALENDAR_ROOT, "Calendar.module.css"), "utf8");

  assert.match(component, /hasDots && styles\.dayWithDots/u);
  assert.match(component, /className=\{styles\.dayNumber\}/u);
  assert.match(styles, /\.dayWithDots\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto;/u);
  assert.match(styles, /\.dots\s*\{[\s\S]*?grid-row:\s*2;/u);
  assert.doesNotMatch(styles, /\.dots\s*\{[^}]*position:\s*absolute/u);
});
