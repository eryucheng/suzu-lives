import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFeatureConnectionOverrides,
  imageVisionBaseUrlFromPublicConfig,
  imageVisionModelFromPublicConfig,
} from "../electron/services/connection-model-overrides.mjs";

test("shared image connection keeps the image-vision model from its public feature configuration", async () => {
  const connection = { key: "fixture-key", baseUrl: "https://relay.example.test/v1", model: "image-generator-model" };
  const result = await applyFeatureConnectionOverrides({
    kind: "image-vision",
    dataRoot: "C:\\fixture-data",
    connection,
    readFile: async () => JSON.stringify({ openai: { base_url: "https://vision-relay.example.test/v1", model: "vision-model" } }),
  });

  assert.equal(result.key, "fixture-key");
  assert.equal(result.baseUrl, "https://vision-relay.example.test/v1");
  assert.equal(result.model, "vision-model");
});

test("vision-specific model takes precedence and missing public configuration does not change a shared connection", async () => {
  assert.equal(imageVisionModelFromPublicConfig({ openai: { model: "fallback" }, vision: { model: "preferred" } }), "preferred");
  assert.equal(imageVisionBaseUrlFromPublicConfig({ openai: { base_url: "https://fallback.example.test/v1" }, vision: { baseUrl: "https://preferred.example.test/v1" } }), "https://preferred.example.test/v1");
  const connection = { key: "fixture-key", baseUrl: "https://relay.example.test/v1", model: "image-generator-model" };
  const result = await applyFeatureConnectionOverrides({
    kind: "image-vision",
    dataRoot: "C:\\fixture-data",
    connection,
    readFile: async () => { throw new Error("missing"); },
  });
  assert.deepEqual(result, connection);
});
