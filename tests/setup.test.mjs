import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "scripts/setup.mjs",
  "memory/manual_compactor/config.example.json",
  "memory/rag/config.example.json",
  "scripts/abilities/phone-camera/config.example.json",
  "scripts/abilities/image-generation/config.example.json",
  "scripts/abilities/image-generation/workflows/registry.example.json",
  "scripts/abilities/image-vision/config.example.json",
  "scripts/abilities/connect_iphone/feedback_config.example.json",
  "assets/visual-references/manifest.example.json",
  "user.example.md",
];

function copyFixture(root) {
  for (const relativePath of sources) {
    const source = path.join(repositoryRoot, relativePath);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

test("setup 创建用户档案并迁移旧视觉参考清单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-setup-"));
  try {
    copyFixture(root);
    const legacyPath = path.join(root, "visual-references", "manifest.json");
    const legacyImage = path.join(root, "visual-references", "places", "room.jpg");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyImage), { recursive: true });
    fs.writeFileSync(legacyImage, "fake-image", "utf8");
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        assets: { legacy: { path: "places/room.jpg" } },
        sets: {},
      }),
      "utf8",
    );

    const result = spawnSync(process.execPath, ["scripts/setup.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const migrated = JSON.parse(
      fs.readFileSync(
        path.join(root, "assets", "visual-references", "manifest.json"),
        "utf8",
      ),
    );
    assert.ok(migrated.assets.legacy);
    assert.equal(
      fs.readFileSync(
        path.join(root, "assets", "visual-references", "places", "room.jpg"),
        "utf8",
      ),
      "fake-image",
    );
    assert.ok(fs.existsSync(path.join(root, "user.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
