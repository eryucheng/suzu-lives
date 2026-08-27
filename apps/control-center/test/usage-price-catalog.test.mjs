import assert from "node:assert/strict";
import test from "node:test";

import {
  priceCatalogModelKeys,
  usedPriceCatalogModels,
} from "../src/features/usage/usage-price-catalog.mjs";

const MODELS = [
  { modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol", aliases: ["gpt-5.6"] },
  { modelId: "minimax-m3", label: "MiniMax M3", aliases: ["MiniMax-M3"] },
  { modelId: "glm-5.2", label: "GLM-5.2", aliases: [] },
];

test("only returns catalog prices used by the current ledger", () => {
  assert.deepEqual(
    usedPriceCatalogModels(MODELS, [{ model: "MiniMax-M3" }]).map((model) => model.modelId),
    ["minimax-m3"],
  );
});

test("matches a used model through its resolved price revision", () => {
  assert.deepEqual(
    usedPriceCatalogModels(MODELS, [{ model: "provider-specific-alias", priceRevision: { modelId: "gpt-5.6-sol" } }])
      .map((model) => model.modelId),
    ["gpt-5.6-sol"],
  );
});

test("keeps the full catalog available for coverage checks", () => {
  const keys = priceCatalogModelKeys(MODELS);
  assert.equal(keys.has("gpt-5.6"), true);
  assert.equal(keys.has("minimax-m3"), true);
  assert.equal(keys.has("glm-5.2"), true);
});
