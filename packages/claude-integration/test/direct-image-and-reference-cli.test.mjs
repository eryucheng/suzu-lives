import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "bin", "suzu-lives.mjs");
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-direct-cli-")); }

test("stable CLI dispatches image-generation and visual-reference-manager from software paths", async () => {
  const root = await temporary(); const agentRoot = path.join(root, "agents", "fixture");
  const workflows = path.join(agentRoot, "image-generation", "workflows"); await fs.mkdir(workflows, { recursive: true });
  await fs.writeFile(path.join(agentRoot, "image-generation", "config.json"), JSON.stringify({ comfyui: { registry: "workflows/registry.json" } }));
  await fs.writeFile(path.join(workflows, "registry.json"), JSON.stringify({ version: 1, workflows: {} }));
  const image = await execFileAsync(process.execPath, [cli, "image-generation", "--list-workflows", "--data-root", root, "--agent-id", "fixture"], { cwd: packageRoot });
  assert.deepEqual(JSON.parse(image.stdout), { status: "ok", registry: "image-generation/workflows/registry.json", workflows: [] });
  const references = await execFileAsync(process.execPath, [cli, "visual-reference-manager", "init", "--data-root", root, "--agent-id", "fixture"], { cwd: packageRoot });
  const initialized = JSON.parse(references.stdout);
  assert.equal(initialized.status, "ready");
  assert.match(initialized.manifest, /agents[\\/]fixture[\\/]visual-references[\\/]manifest\.json$/u);
});
