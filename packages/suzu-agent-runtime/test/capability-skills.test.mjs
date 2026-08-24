import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuCapabilitySkills } from "../src/capability-skills.mjs";

test("product capability Skills publish summaries and load detailed contracts only on demand", async () => {
  const requests = [];
  let provider;
  const registration = new AbortController();
  createSuzuCapabilitySkills({
    transport: {
      async request(event, payload, options) {
        requests.push({ event, payload, options });
        if (event === "CapabilitySkillCatalog") {
          return {
            available: true,
            result: {
              skills: [
                { name: "suzu-image-generation", description: "图像生成：生成、编辑图片。" },
                { name: "not a skill", description: "不应进入目录。" },
              ],
            },
          };
        }
        return {
          available: true,
          result: {
            skill: {
              name: "suzu-image-generation",
              description: "图像生成：生成、编辑图片。",
              content: "# 图像生成\n\n使用 image-generation.generate。",
            },
          },
        };
      },
    },
  }).apply({
    skills: {
      registerProvider(factory) {
        provider = factory({ signal: registration.signal, invalidate() {} });
      },
    },
  }, { timeoutMs: 2_000 });

  const scope = { session: { id: "session-1" } };
  const listed = await provider.list({ scope });
  assert.equal(listed.complete, true);
  assert.deepEqual(listed.candidates.map((entry) => ({ name: entry.name, description: entry.description })), [
    { name: "suzu-image-generation", description: "图像生成：生成、编辑图片。" },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].event, "CapabilitySkillCatalog");
  assert.deepEqual(requests[0].payload, { sessionId: "session-1" });

  const loaded = await provider.get(listed.candidates[0], { scope });
  assert.deepEqual(loaded, {
    name: "suzu-image-generation",
    description: "图像生成：生成、编辑图片。",
    content: "# 图像生成\n\n使用 image-generation.generate。",
    invocation: { modelInvocable: true, userInvocable: false },
    source: "suzu-product",
    provider: "suzu-product-capabilities",
  });
  assert.deepEqual(requests[1], {
    event: "CapabilitySkillRead",
    payload: { sessionId: "session-1", name: "suzu-image-generation" },
    options: { timeoutMs: 2_000 },
  });
});

test("product capability Skills never look up a catalog outside an Agent session", async () => {
  let requests = 0;
  let provider;
  createSuzuCapabilitySkills({
    transport: { async request() { requests += 1; return { available: true, result: { skills: [] } }; } },
  }).apply({
    skills: {
      registerProvider(factory) {
        provider = factory({ signal: new AbortController().signal, invalidate() {} });
      },
    },
  });

  assert.deepEqual(await provider.list({}), { candidates: [], complete: true });
  assert.equal(requests, 0);
});
