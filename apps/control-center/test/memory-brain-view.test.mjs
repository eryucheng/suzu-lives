import assert from "node:assert/strict";
import test from "node:test";

import { memoryBrainEdgeMode } from "../src/features/memory-brain/brain-view.mjs";

test("memory brain keeps unrelated graph lines hidden and reveals ambient or direct edges", () => {
  const direct = { id: "edge-direct", source: "selected", target: "neighbor" };
  const secondHop = { id: "edge-second-hop", source: "neighbor", target: "far-node" };

  assert.equal(memoryBrainEdgeMode(direct), "hidden");
  assert.equal(memoryBrainEdgeMode(direct, { ambientStrength: 0.7 }), "ambient");
  assert.equal(memoryBrainEdgeMode(direct, { selectedId: "selected", ambientStrength: 0.7 }), "direct");
  assert.equal(memoryBrainEdgeMode(secondHop, { selectedId: "selected", ambientStrength: 0.7 }), "hidden");
});
