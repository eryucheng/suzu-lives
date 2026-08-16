import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("plans page opens persisted trigger history from the action beside the create button", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "plans-page.jsx"), "utf8");
  const styles = readFileSync(resolve(ROOT, "src", "react", "plans-page.css"), "utf8");

  assert.match(page, /function PlansHistoryCard/u);
  assert.match(page, /function PlansHistoryDialog/u);
  assert.match(page, /currentSnapshot\?\.history/u);
  assert.match(page, /const \[historyOpen, setHistoryOpen\] = useState\(false\)/u);
  assert.match(page, /计划历史/u);
  assert.match(page, /已进入会话队列/u);
  assert.match(page, /setHistoryOpen\(true\)/u);
  assert.match(page, /historyOpen \? <PlansHistoryDialog/u);
  assert.match(styles, /\.plans-page-actions\s*\{/u);
  assert.match(styles, /\.plans-history-dialog\s*\{/u);
  assert.match(styles, /\.plans-history-card\s*\{/u);
  assert.doesNotMatch(page, /<section className="plans-history"/u);
});
