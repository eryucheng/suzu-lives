import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("recurring calendar dates add only their year before marking the matching day", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "today-page.jsx"), "utf8");

  assert.match(page, /const key = String\(event\.date \|\| ""\)\.length === 5 \? `\$\{year\}-\$\{event\.date\}` : String\(event\.date \|\| ""\);/u);
  assert.doesNotMatch(page, /`\$\{prefix\}\$\{event\.date\}`/u);
});
