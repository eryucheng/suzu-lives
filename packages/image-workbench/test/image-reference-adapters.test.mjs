import assert from "node:assert/strict";
import test from "node:test";

import {
  imageReferenceAdapterOptions,
  imageReferenceCapability,
} from "../src/image-reference-adapters.mjs";

test("an unconfigured model disables references with an actionable reason", () => {
  const capability = imageReferenceCapability({
    connection: { model: "provider-image-model", type: "openai-compatible" },
    imageGenerationAdapter: "openai-images",
  });

  assert.equal(capability.supported, false);
  assert.match(capability.reason, /模型“provider-image-model”尚未配置参考图适配器/u);
  assert.match(capability.reason, /能力 → 图像生成/u);
  assert.equal(capability.maxReferences, 0);
});

test("a model change disables the former reference format before an upload", () => {
  const capability = imageReferenceCapability({
    connection: { model: "new-image-model", type: "openai-compatible" },
    imageGenerationAdapter: "openai-images",
    referenceImageAdapter: "openai-images-edit",
    referenceImageModel: "old-image-model",
  });

  assert.equal(capability.supported, false);
  assert.match(capability.reason, /old-image-model/u);
  assert.match(capability.reason, /new-image-model/u);
  assert.match(capability.reason, /模型切换/u);
});

test("built-in reference adapters expose only compatible request protocols", () => {
  const dashscope = imageReferenceCapability({
    connection: { model: "wan2.7-image", type: "dashscope" },
    imageGenerationAdapter: "auto",
    referenceImageAdapter: "dashscope-multimodal",
    referenceImageModel: "wan2.7-image",
  });
  const options = imageReferenceAdapterOptions({ imageGenerationAdapter: "dashscope-image", connectionType: "dashscope" });

  assert.equal(dashscope.supported, true);
  assert.equal(dashscope.maxReferences, 9);
  assert.deepEqual(options.map(([id]) => id), ["none", "dashscope-multimodal"]);
});

test("an incompatible selected API type explains why references are unavailable", () => {
  const capability = imageReferenceCapability({
    connection: { model: "image-model", type: "openai-compatible" },
    imageGenerationAdapter: "dashscope-image",
    referenceImageAdapter: "dashscope-multimodal",
    referenceImageModel: "image-model",
  });

  assert.equal(capability.supported, false);
  assert.match(capability.reason, /当前选中的 API 类型“openai-compatible”不能使用/u);
  assert.match(capability.reason, /选择兼容的 API/u);
});

test("custom JSON reference adapters explain a missing reference variable", () => {
  const base = {
    connection: { model: "custom-image", type: "generic-api" },
    imageGenerationAdapter: "custom-http-image",
    referenceImageAdapter: "custom-data-url-array",
    referenceImageModel: "custom-image",
  };
  const disabled = imageReferenceCapability({
    ...base,
    customImageGenerationAdapter: { name: "自定义生图", requestBody: { prompt: "{{prompt}}" } },
  });
  const enabled = imageReferenceCapability({
    ...base,
    customImageGenerationAdapter: { name: "自定义生图", requestBody: { images: "{{referenceImages}}", prompt: "{{prompt}}" } },
  });

  assert.equal(disabled.supported, false);
  assert.match(disabled.reason, /没有 \{\{referenceImages\}\}/u);
  assert.equal(enabled.supported, true);
  assert.equal(enabled.maxReferences, 16);
});
