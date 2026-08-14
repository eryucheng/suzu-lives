import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ExternalCapabilityError,
  createExternalCapabilitiesService,
  validateExternalCapabilityManifest,
} from "../src/index.mjs";

function manifest({ id = "weather.demo", version = "1.0.0", adapters } = {}) {
  return {
    schemaVersion: 1,
    id,
    name: "本地天气",
    version,
    description: "读取本地天气来源。",
    adapters: adapters || {
      skill: { file: "SKILL.md" },
      mcp: { transport: "stdio", command: "node", args: ["./server.mjs"], env: { WEATHER_CACHE: "${WEATHER_CACHE_DIR:-./cache}" } },
      cli: { command: "weather-demo", args: ["--json"] },
    },
  };
}

async function fixture({ projectMcp = null } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-external-capability-"));
  const dataRoot = path.join(base, "data");
  const packageRoot = path.join(base, "weather-package");
  const projectRoot = path.join(base, "contact-project");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: local-weather\ndescription: A local weather Skill\n---\n\nUse the local capability core.\n", "utf8");
  await fs.writeFile(path.join(packageRoot, "server.mjs"), "export function start() {}\n", "utf8");
  const manifestPath = path.join(packageRoot, "suzu-capability.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, "utf8");
  if (projectMcp) await fs.writeFile(path.join(projectRoot, ".mcp.json"), `${JSON.stringify(projectMcp, null, 2)}\n`, "utf8");
  return { dataRoot, packageRoot, projectRoot, manifestPath };
}

function directorySkillManifest({ id = "weather.demo", version = "1.0.0", directory = "skill" } = {}) {
  return manifest({ id, version, adapters: { skill: { directory } } });
}

async function writeSkillPackage(packageRoot, directory, files) {
  const root = path.join(packageRoot, directory);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function writeCapabilityManifest(current, value) {
  await fs.writeFile(current.manifestPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("V1 manifest validation is strict while retaining the CLI adapter field", () => {
  const normalized = validateExternalCapabilityManifest(manifest());
  assert.equal(normalized.adapters.cli.command, "weather-demo");
  assert.throws(
    () => validateExternalCapabilityManifest({ ...manifest(), unexpected: true }),
    (error) => error instanceof ExternalCapabilityError && error.code === "external-manifest-invalid",
  );
  assert.throws(
    () => validateExternalCapabilityManifest(manifest({ adapters: { cli: { command: "weather-demo" } } })),
    /至少需要一个 Skill 或 MCP/u,
  );
  assert.throws(
    () => validateExternalCapabilityManifest(manifest({ adapters: { skill: { file: "../SKILL.md" } } })),
    /不能离开能力包/u,
  );
  assert.deepEqual(
    validateExternalCapabilityManifest(directorySkillManifest({ directory: "skills/weather" })).adapters.skill,
    { directory: "skills/weather" },
  );
  assert.throws(
    () => validateExternalCapabilityManifest(manifest({ adapters: { skill: { file: "SKILL.md", directory: "skill" } } })),
    /只能提供 file 或 directory/u,
  );
  assert.throws(
    () => validateExternalCapabilityManifest(manifest({ adapters: { skill: {} } })),
    /只能提供 file 或 directory/u,
  );
  assert.throws(
    () => validateExternalCapabilityManifest({ ...manifest(), description: false }),
    /能力说明/u,
  );
  assert.throws(
    () => validateExternalCapabilityManifest(manifest({ adapters: { mcp: { transport: "stdio", command: "node", args: ["../server.mjs"] } } })),
    /不能使用会离开能力包/u,
  );
});

test("import persists a selected manifest and updates the same capability ID", async () => {
  const current = await fixture();
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  const first = await service.importManifest({ manifestPath: current.manifestPath });
  assert.equal(first.created, true);
  assert.equal(first.capability.id, "weather.demo");
  const auditPath = path.join(current.dataRoot, "external-capabilities", "manifests", "weather.demo", "suzu-capability.json");
  const registryPath = path.join(current.dataRoot, "external-capabilities", "registry.json");
  assert.match(await fs.readFile(auditPath, "utf8"), /weather\.demo/u);
  assert.equal(JSON.parse(await fs.readFile(registryPath, "utf8")).capabilities["weather.demo"].manifest.version, "1.0.0");

  await fs.writeFile(current.manifestPath, `${JSON.stringify(manifest({ version: "1.1.0" }), null, 2)}\n`, "utf8");
  const update = await service.importManifest({ manifestPath: current.manifestPath });
  assert.equal(update.updated, true);
  assert.equal(update.snapshot.capabilities[0].version, "1.1.0");
});

test("enable and disable register only managed Skill and MCP entries while preserving user MCP config", async () => {
  const current = await fixture({
    projectMcp: {
      mcpServers: {
        "user-server": { type: "stdio", command: "user-command", args: [] },
      },
      userOwnedSetting: true,
    },
  });
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  const enabled = await service.setEnabled({ id: "weather.demo", enabled: true });
  assert.equal(enabled.snapshot.capabilities[0].enabled, true);

  const skillPath = path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo", "SKILL.md");
  const skill = await fs.readFile(skillPath, "utf8");
  assert.match(skill, /Use the local capability core/u);
  assert.match(skill, /suzu-lives:external-capability:weather\.demo/u);
  const mcp = JSON.parse(await fs.readFile(path.join(current.projectRoot, ".mcp.json"), "utf8"));
  assert.equal(mcp.userOwnedSetting, true);
  assert.equal(mcp.mcpServers["user-server"].command, "user-command");
  assert.equal(mcp.mcpServers["suzu-external-weather.demo"].command, "node");
  assert.equal(mcp.mcpServers["suzu-external-weather.demo"].args[0], path.join(current.packageRoot, "server.mjs"));

  const disabled = await service.setEnabled({ id: "weather.demo", enabled: false });
  assert.equal(disabled.snapshot.capabilities[0].enabled, false);
  await assert.rejects(() => fs.readFile(skillPath, "utf8"), { code: "ENOENT" });
  const after = JSON.parse(await fs.readFile(path.join(current.projectRoot, ".mcp.json"), "utf8"));
  assert.equal(after.mcpServers["user-server"].command, "user-command");
  assert.equal(after.mcpServers["suzu-external-weather.demo"], undefined);
});

test("an HTTP MCP manifest is registered as configuration only and never contacted during enable", async () => {
  const current = await fixture();
  const httpManifest = manifest({
    id: "weather.http",
    adapters: {
      mcp: { transport: "http", url: "https://weather.example.test/mcp", headers: { "X-Client": "suzu-lives" } },
      cli: { command: "weather-http-cli", args: ["--json"] },
    },
  });
  await fs.writeFile(current.manifestPath, `${JSON.stringify(httpManifest, null, 2)}\n`, "utf8");
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  const result = await service.setEnabled({ id: "weather.http", enabled: true });
  assert.equal(result.snapshot.capabilities[0].enabled, true);
  const mcp = JSON.parse(await fs.readFile(path.join(current.projectRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["suzu-external-weather.http"], {
    type: "http",
    url: "https://weather.example.test/mcp",
    headers: { "X-Client": "suzu-lives" },
  });
  await assert.rejects(
    () => fs.readFile(path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.http", "SKILL.md"), "utf8"),
    { code: "ENOENT" },
  );
});

test("a colliding user Skill or MCP entry is never overwritten", async () => {
  const current = await fixture({
    projectMcp: {
      mcpServers: {
        "suzu-external-weather.demo": { type: "stdio", command: "user-command", args: ["--keep"] },
      },
    },
  });
  const userSkillPath = path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo", "SKILL.md");
  await fs.mkdir(path.dirname(userSkillPath), { recursive: true });
  await fs.writeFile(userSkillPath, "user-owned Skill\n", "utf8");
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-skill-conflict",
  );
  assert.equal(await fs.readFile(userSkillPath, "utf8"), "user-owned Skill\n");
  const mcp = JSON.parse(await fs.readFile(path.join(current.projectRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["suzu-external-weather.demo"], { type: "stdio", command: "user-command", args: ["--keep"] });
});

test("a colliding user MCP entry is not overwritten even when the Skill path is available", async () => {
  const current = await fixture({
    projectMcp: {
      mcpServers: {
        "suzu-external-weather.demo": { type: "stdio", command: "user-command", args: ["--keep"] },
      },
    },
  });
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-mcp-conflict",
  );
  const mcp = JSON.parse(await fs.readFile(path.join(current.projectRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["suzu-external-weather.demo"], { type: "stdio", command: "user-command", args: ["--keep"] });
  await assert.rejects(
    () => fs.readFile(path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo", "SKILL.md"), "utf8"),
    { code: "ENOENT" },
  );
});

test("a missing local Skill source remains visible as a static diagnostic and cannot be enabled", async () => {
  const current = await fixture();
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await fs.unlink(path.join(current.packageRoot, "SKILL.md"));
  const snapshot = await service.snapshot();
  assert.ok(snapshot.capabilities[0].diagnostics.some((item) => item.code === "skill-source-missing"));
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-source-missing",
  );
});

test("enable clearly requires a current contact project while import stays local", async () => {
  const current = await fixture();
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-project-missing" && /当前联系人/u.test(error.message),
  );
});

test("a directory Skill installs its nested scripts, references, and binary assets without execution", async () => {
  const current = await fixture();
  await writeSkillPackage(current.packageRoot, "skill", {
    "SKILL.md": "---\nname: packaged-weather\ndescription: Read package assets\n---\n\nUse scripts only when the host approves.\n",
    "scripts/format-weather.mjs": "export const format = (value) => value;\n",
    "references/contract.md": "# Contract\n\nUse the stable core.\n",
    "assets/icon.bin": Buffer.from([0, 1, 2, 255]),
  });
  await writeCapabilityManifest(current, directorySkillManifest());
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });

  const installedRoot = path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo");
  assert.match(await fs.readFile(path.join(installedRoot, "SKILL.md"), "utf8"), /packaged-weather/u);
  assert.equal(await fs.readFile(path.join(installedRoot, "scripts", "format-weather.mjs"), "utf8"), "export const format = (value) => value;\n");
  assert.equal(await fs.readFile(path.join(installedRoot, "references", "contract.md"), "utf8"), "# Contract\n\nUse the stable core.\n");
  assert.deepEqual(await fs.readFile(path.join(installedRoot, "assets", "icon.bin")), Buffer.from([0, 1, 2, 255]));
  const metadata = JSON.parse(await fs.readFile(path.join(installedRoot, ".suzu-lives-external-capability.json"), "utf8"));
  assert.equal(metadata.schemaVersion, 2);
  assert.deepEqual(Object.keys(metadata.files).sort(), ["SKILL.md", "assets/icon.bin", "references/contract.md", "scripts/format-weather.mjs"]);
});

test("directory Skill updates prune only expired managed files and preserve user additions on disable and remove", async () => {
  const current = await fixture();
  await writeSkillPackage(current.packageRoot, "skill-v1", {
    "SKILL.md": "---\nname: packaged-weather\ndescription: V1\n---\n\nUse the V1 package.\n",
    "scripts/obsolete.mjs": "export const obsolete = true;\n",
    "references/guide.md": "# V1 guide\n",
  });
  await writeSkillPackage(current.packageRoot, "skill-v2", {
    "SKILL.md": "---\nname: packaged-weather\ndescription: V2\n---\n\nUse the V2 package.\n",
    "scripts/current.mjs": "export const current = true;\n",
    "references/guide.md": "# V2 guide\n",
  });
  await writeCapabilityManifest(current, directorySkillManifest({ directory: "skill-v1" }));
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  const installedRoot = path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo");
  const userFile = path.join(installedRoot, "notes", "user-owned.md");
  await fs.mkdir(path.dirname(userFile), { recursive: true });
  await fs.writeFile(userFile, "keep this user note\n", "utf8");

  await writeCapabilityManifest(current, directorySkillManifest({ version: "1.1.0", directory: "skill-v2" }));
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  await assert.rejects(() => fs.readFile(path.join(installedRoot, "scripts", "obsolete.mjs")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(installedRoot, "scripts", "current.mjs"), "utf8"), "export const current = true;\n");
  assert.equal(await fs.readFile(userFile, "utf8"), "keep this user note\n");

  await service.setEnabled({ id: "weather.demo", enabled: false });
  await assert.rejects(() => fs.readFile(path.join(installedRoot, "scripts", "current.mjs")), { code: "ENOENT" });
  assert.equal(await fs.readFile(userFile, "utf8"), "keep this user note\n");

  await service.setEnabled({ id: "weather.demo", enabled: true });
  await service.remove({ id: "weather.demo", confirmed: true });
  await assert.rejects(() => fs.readFile(path.join(installedRoot, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(userFile, "utf8"), "keep this user note\n");
});

test("directory Skill never overwrites hand-modified managed files or a colliding user file", async () => {
  const current = await fixture();
  await writeSkillPackage(current.packageRoot, "skill-v1", {
    "SKILL.md": "---\nname: packaged-weather\ndescription: V1\n---\n\nUse the package.\n",
    "scripts/format.mjs": "export const version = 1;\n",
  });
  await writeSkillPackage(current.packageRoot, "skill-v2", {
    "SKILL.md": "---\nname: packaged-weather\ndescription: V2\n---\n\nUse the package.\n",
    "scripts/format.mjs": "export const version = 2;\n",
    "references/user-owned.md": "this would collide\n",
  });
  await writeCapabilityManifest(current, directorySkillManifest({ directory: "skill-v1" }));
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  const installedRoot = path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo");
  const managedScript = path.join(installedRoot, "scripts", "format.mjs");
  await fs.writeFile(managedScript, "user changed the managed script\n", "utf8");
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-skill-modified",
  );
  assert.equal(await fs.readFile(managedScript, "utf8"), "user changed the managed script\n");

  await fs.writeFile(managedScript, "export const version = 1;\n", "utf8");
  const userFile = path.join(installedRoot, "references", "user-owned.md");
  await fs.mkdir(path.dirname(userFile), { recursive: true });
  await fs.writeFile(userFile, "user content wins\n", "utf8");
  await writeCapabilityManifest(current, directorySkillManifest({ version: "1.1.0", directory: "skill-v2" }));
  await service.importManifest({ manifestPath: current.manifestPath });
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-skill-conflict",
  );
  assert.equal(await fs.readFile(userFile, "utf8"), "user content wins\n");
  assert.equal(await fs.readFile(managedScript, "utf8"), "export const version = 1;\n");
});

test("the legacy skill.file manifest remains usable and upgrades valid V1 ownership metadata", async () => {
  const current = await fixture();
  await writeCapabilityManifest(current, manifest({ adapters: { skill: { file: "SKILL.md" } } }));
  const service = createExternalCapabilitiesService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  const installedRoot = path.join(current.projectRoot, ".claude", "skills", "suzu-external-weather.demo");
  const skillPath = path.join(installedRoot, "SKILL.md");
  const metadataPath = path.join(installedRoot, ".suzu-lives-external-capability.json");
  const installedSkill = await fs.readFile(skillPath);
  await fs.writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    capabilityId: "weather.demo",
    version: "1.0.0",
    contentSha256: createHash("sha256").update(installedSkill).digest("hex"),
    registeredAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");
  await writeCapabilityManifest(current, manifest({ version: "1.1.0", adapters: { skill: { file: "SKILL.md" } } }));
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  const upgraded = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(typeof upgraded.files["SKILL.md"], "string");
  assert.match(await fs.readFile(skillPath, "utf8"), /local-weather/u);
});
