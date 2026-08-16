import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("React usage settings lets users create their own model price mapping", () => {
  const page = readFileSync(resolve(ROOT, "src", "react", "admin-page.jsx"), "utf8");
  const app = readFileSync(resolve(ROOT, "src", "app.mjs"), "utf8");

  assert.match(page, /function CustomPriceModelDialog/u);
  assert.match(page, /新建模型价格/u);
  assert.match(page, /CUSTOM_PRICE_TEMPLATES/u);
  assert.match(page, /actions\?\.createPriceModel/u);
  assert.match(app, /async function createAdminPriceModel/u);
  assert.match(app, /customPriceModels/u);
  assert.match(app, /createPriceModel: createAdminPriceModel/u);
});
