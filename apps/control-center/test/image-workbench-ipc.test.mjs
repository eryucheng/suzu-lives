import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configuredImageWorkbenchConnection } from "../electron/ipc/image-workbench-ipc.mjs";

test("image workbench applies the protocol selected for image generation", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-workbench-protocol-"));
  const configDirectory = path.join(dataRoot, "capabilities", "image-generation");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({ adapter: "dashscope-image" }));

  const connection = await configuredImageWorkbenchConnection({
    dataRoot,
    connection: { apiKey: "fixture-key", baseUrl: "https://dashscope.example.test/api/v1", model: "wan2.7-image", type: "generic-api" },
  });

  assert.equal(connection.imageGenerationAdapter, "dashscope-image");
});
