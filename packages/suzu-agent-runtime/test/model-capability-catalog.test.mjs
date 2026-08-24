import assert from "node:assert/strict";
import test from "node:test";

import {
  modelCatalogEntries,
  modelInputModalities,
  modelSupportsImageInput,
  textModelProviderForRoute,
} from "../src/model-capability-catalog.mjs";
import { DEEPSEEK_VISION_MODEL_IDS } from "../src/deepseek-model-vision.mjs";

test("the model capability catalog keeps provider routes, models, and image input together", () => {
  assert.equal(textModelProviderForRoute("suzu-kimi-api"), "kimi-api");
  assert.equal(modelSupportsImageInput("bailian-payg", "qwen3.8-max"), true);
  assert.equal(modelSupportsImageInput("bailian-payg", "qwen3.6-flash"), true);
  assert.equal(modelSupportsImageInput("kimi-api", "kimi-k2.6"), true);
  assert.equal(modelSupportsImageInput("minimax", "MiniMax-M2.7"), false);
  assert.deepEqual(modelInputModalities("custom", "any-model"), ["text"]);

  const visualBailianModels = modelCatalogEntries("bailian-payg")
    .filter((entry) => entry.input.includes("image"))
    .map((entry) => entry.id);
  assert.deepEqual(visualBailianModels, [
    "qwen3.8-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "qwen3-vl-plus",
    "qwen3-vl-flash",
    "qwen3.6-flash",
  ]);
});

test("the native DeepSeek adapter derives its vision list from the shared catalog", () => {
  const catalogVisionModels = modelCatalogEntries("deepseek")
    .filter((entry) => entry.input.includes("image"))
    .map((entry) => entry.id);
  assert.deepEqual([...DEEPSEEK_VISION_MODEL_IDS], catalogVisionModels);
});
