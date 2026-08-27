import assert from "node:assert/strict";
import test from "node:test";

import { inferContactAvatarCrop } from "../electron/services/contact-avatar-cropping.mjs";

test("contact avatar crop uses the one-shot image route and returns normalized coordinates", async () => {
  const calls = [];
  const runtime = {
    async runTransientInference(value) {
      calls.push(value);
      return {
        available: true,
        result: {
          ok: true,
          output: {
            left: 18,
            top: 6,
            right: 76,
            bottom: 42,
            confidence: 0.94,
          },
        },
      };
    },
  };

  const result = await inferContactAvatarCrop({
    data: Buffer.from([1, 2, 3]),
    fileName: "makima.webp",
    mimeType: "image/webp",
    runtime,
  });

  assert.deepEqual(result, {
    available: true,
    box: { left: 0.18, top: 0.06, right: 0.76, bottom: 0.42 },
    confidence: 0.94,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, "avatar.crop.v1");
  assert.equal(calls[0].schemaName, "avatar-crop-v1");
  assert.equal(calls[0].content[1].type, "image");
  assert.equal(calls[0].content[1].mediaType, "image/webp");
  assert.equal(calls[0].content[1].data, Buffer.from([1, 2, 3]).toString("base64"));
});

test("contact avatar crop cleanly falls back when visual inference is unavailable or invalid", async () => {
  assert.deepEqual(await inferContactAvatarCrop({ data: Buffer.from([1]) }), {
    available: false,
    reason: "transient-inference-unavailable",
  });
  assert.deepEqual(await inferContactAvatarCrop({
    data: Buffer.from([1]),
    runtime: {
      async runTransientInference() {
        return {
          available: true,
          result: {
            ok: true,
            output: { left: 0.8, top: 0.2, right: 0.3, bottom: 0.4, confidence: 1 },
          },
        };
      },
    },
  }), {
    available: false,
    reason: "crop-box-invalid",
  });
});
