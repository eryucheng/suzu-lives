import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SUZU_ADMIN_TABS } from "../src/core/chat-first.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("DSH management keeps identity, model configuration, and editable custom prices available", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "admin-page.jsx"), "utf8");
  const ledger = readFileSync(resolve(ROOT, "electron", "services", "cost-ledger.mjs"), "utf8");

  assert.match(ledger, /createPriceCatalog\(\{ customPriceModels: settings\.customPriceModels \|\| \[\] \}\)/u);
  assert.match(page, /function CustomPriceModelDialog/u);
  assert.match(page, /新建模型价格/u);
  assert.match(page, /createPriceModel/u);
  assert.deepEqual(SUZU_ADMIN_TABS, ["agent", "usage"]);
  assert.match(page, /agent: "我"/u);
  assert.match(page, /usage: "用量与成本"/u);
  assert.match(page, /tab === "agent" \? <IdentitySettings/u);
  assert.match(page, /tab === "usage" \? <UsageSettings/u);
});
