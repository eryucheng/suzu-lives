import assert from "node:assert/strict";
import test from "node:test";

import { imageUsageEvent } from "../electron/ipc/image-workbench-ipc.mjs";

test("ComfyUI usage entries remain explicitly local and unpriced", () => {
  const event = imageUsageEvent({ settings: { agentId: "suzu" } }, { provider: "fixture" }, { input: { backend: "comfyui", size: "1024x1024" }, result: { model: "ComfyUI / local", mode: "workflow", requestId: "prompt-a", usage: {}, workflow: "local" }, referenceCount: 2 });
  assert.equal(event.provider, "本地 ComfyUI");
  assert.equal(event.feature, "image-workflow");
  assert.equal(event.metadata.costSource, "local-unpriced");
  assert.equal(event.metadata.workflow, "local");
});
