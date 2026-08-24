import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ensureAgentRuntimeConfig } from "../src/features/agent/runtime.mjs";

test("main-model startup warmup reads once and keeps the saved replacement", async () => {
  const initial = Object.freeze({ model: "deepseek-v4-flash-vision-exp", status: "ready" });
  const replacement = Object.freeze({ model: "deepseek-v4-pro", status: "ready" });
  let reads = 0;
  const context = {
    api: {
      agentRuntime: {
        async snapshot() {
          reads += 1;
          return initial;
        },
      },
    },
    state: { agentRuntime: null },
  };

  const [first, second] = await Promise.all([
    ensureAgentRuntimeConfig(context),
    ensureAgentRuntimeConfig(context),
  ]);
  assert.equal(first, initial);
  assert.equal(second, initial);
  assert.equal(reads, 1);

  // The save-model IPC returns a new runtime snapshot, which the app stores
  // directly. It must become the cache without issuing another read.
  context.state.agentRuntime = replacement;
  assert.equal(await ensureAgentRuntimeConfig(context), replacement);
  assert.equal(reads, 1);
});

test("completed installations warm the main-model cache during app startup", async () => {
  const application = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");

  assert.match(application, /const agentRuntimeSnapshot = ensureAgentRuntimeConfig\(context\)\.catch\(\(\) => null\);/u);
  assert.match(application, /\[state\.agentRuntime, state\.releaseAnnouncement\] = await Promise\.all\(\[\s*agentRuntimeSnapshot,/u);
  assert.doesNotMatch(application, /requiresOnboarding \? api\.agentRuntime\.snapshot\(\)\.catch\(\(\) => null\) : Promise\.resolve\(null\)/u);
});
