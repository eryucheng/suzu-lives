import assert from "node:assert/strict";
import test from "node:test";

import { memoryBrainEdgeMode, memoryBrainPalette } from "../src/features/memory-brain/brain-view.mjs";

test("memory brain keeps ordinary unrelated lines hidden while retaining the structural skeleton", () => {
  const direct = { id: "edge-direct", source: "selected", target: "neighbor" };
  const structural = {
    id: "edge-structural",
    source: "memory-user-age",
    target: "topology:user",
    structural: true,
  };
  const secondHop = { id: "edge-second-hop", source: "neighbor", target: "far-node" };

  assert.equal(memoryBrainEdgeMode(direct), "hidden");
  assert.equal(memoryBrainEdgeMode(structural), "structural");
  assert.equal(memoryBrainEdgeMode(direct, { ambientStrength: 0.7 }), "ambient");
  assert.equal(memoryBrainEdgeMode(direct, { selectedId: "selected", ambientStrength: 0.7 }), "direct");
  assert.equal(memoryBrainEdgeMode(structural, { selectedId: "selected" }), "hidden");
  assert.equal(memoryBrainEdgeMode(secondHop, { selectedId: "selected", ambientStrength: 0.7 }), "hidden");
});

test("memory brain uses a dedicated high-contrast palette on light surfaces", () => {
  const dark = memoryBrainPalette("dark");
  const light = memoryBrainPalette("light");

  assert.notEqual(light, dark);
  assert.notEqual(light.relation, dark.relation);
  assert.notEqual(light.nodes.minor.event, dark.nodes.minor.event);
  assert.notEqual(light.selected, dark.selected);
  assert.equal(dark.nodes.minor.event, "220, 246, 255");
  assert.equal(dark.stateFallback, "255, 199, 128");
  assert.equal(light.evidenceComposite, "source-over");
  assert.equal(dark.evidenceComposite, "lighter");
  assert.ok(light.relationAlpha > dark.relationAlpha);
  assert.ok(light.glowAlpha < dark.glowAlpha);
});
