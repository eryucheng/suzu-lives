import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

async function fixture() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, "suzu-external-capability-"));
  const dataRoot = path.join(base, "data");
  const packageRoot = path.join(base, "weather-package");
  const projectRoot = path.join(base, "dsh-runtime");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: local-weather\ndescription: A local weather Skill\n---\n\nUse the local capability core.\n", "utf8");
  await fs.writeFile(path.join(packageRoot, "server.mjs"), "export function start() {}\n", "utf8");
  const manifestPath = path.join(packageRoot, "suzu-capability.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, "utf8");
  return { dataRoot, packageRoot, projectRoot, manifestPath };
}

function createRegistrationAdapter() {
  const registrations = new Map();
  const calls = { remove: [], write: [] };
  const keyFor = (projectRoot, capabilityId) => `${path.resolve(projectRoot)}\u0000${capabilityId}`;
  const adapter = {
    async inspect({ projectRoot, capabilityId, types }) {
      const current = registrations.get(keyFor(projectRoot, capabilityId));
      const result = { registered: Boolean(current) };
      for (const type of types) {
        result[type] = current?.types.includes(type)
          ? { registered: true, reason: "", version: current.version }
          : { registered: false, reason: "尚未登记。", version: "" };
      }
      return result;
    },
    async write(input) {
      const types = ["skill", "mcp"].filter((type) => input[type]);
      registrations.set(keyFor(input.projectRoot, input.capabilityId), { types, version: input.version });
      calls.write.push(input);
      return { registered: true };
    },
    async remove(input) {
      registrations.delete(keyFor(input.projectRoot, input.capabilityId));
      calls.remove.push(input);
      return { removed: true };
    },
  };
  return { adapter, calls };
}

function createService(options = {}) {
  const registration = options.registration || createRegistrationAdapter();
  return {
    registration,
    service: createExternalCapabilitiesService({
      registrationAdapter: registration.adapter,
      scopeLabel: "Suzu 的 DSH 运行时",
      ...options,
    }),
  };
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
});

test("external capability service requires its host registration adapter", () => {
  assert.throws(
    () => createExternalCapabilitiesService({ dataRoot: "D:\\Temp\\suzu-external-capabilities-test" }),
    (error) => error instanceof ExternalCapabilityError && error.code === "external-registration-adapter-invalid",
  );
});

test("import persists a selected manifest and updates the same capability ID", async () => {
  const current = await fixture();
  const { service } = createService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  const first = await service.importManifest({ manifestPath: current.manifestPath });
  assert.equal(first.created, true);
  const auditPath = path.join(current.dataRoot, "external-capabilities", "manifests", "weather.demo", "suzu-capability.json");
  assert.match(await fs.readFile(auditPath, "utf8"), /weather\.demo/u);

  await writeCapabilityManifest(current, manifest({ version: "1.1.0" }));
  const update = await service.importManifest({ manifestPath: current.manifestPath });
  assert.equal(update.updated, true);
  assert.equal(update.snapshot.capabilities[0].version, "1.1.0");
});

test("enable and disable use only the explicitly supplied host adapter", async () => {
  const current = await fixture();
  const { registration, service } = createService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });

  const enabled = await service.setEnabled({ id: "weather.demo", enabled: true });
  assert.equal(enabled.snapshot.capabilities[0].enabled, true);
  assert.equal(registration.calls.write.length, 1);
  const [write] = registration.calls.write;
  assert.equal(write.projectRoot, current.projectRoot);
  assert.equal(write.skill.files[0].relativePath, "SKILL.md");
  assert.match(String(write.skill.files[0].content), /local capability core/u);
  assert.deepEqual(write.mcp.configuration, {
    type: "stdio",
    command: "node",
    args: [path.join(current.packageRoot, "server.mjs")],
    env: { WEATHER_CACHE: "${WEATHER_CACHE_DIR:-./cache}" },
  });

  const disabled = await service.setEnabled({ id: "weather.demo", enabled: false });
  assert.equal(disabled.snapshot.capabilities[0].enabled, false);
  assert.deepEqual(registration.calls.remove[0].types.sort(), ["mcp", "skill"]);
});

test("directory Skills are materialized as files for the supplied adapter", async () => {
  const current = await fixture();
  const packageRoot = path.join(current.packageRoot, "weather-skill");
  await fs.mkdir(path.join(packageRoot, "references"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "# Packaged weather\n", "utf8");
  await fs.writeFile(path.join(packageRoot, "references", "guide.md"), "# Guide\n", "utf8");
  await writeCapabilityManifest(current, manifest({ adapters: { skill: { directory: "weather-skill" } } }));
  const { registration, service } = createService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  assert.deepEqual(registration.calls.write[0].skill.files.map((item) => item.relativePath).sort(), ["SKILL.md", "references/guide.md"]);
});

test("missing local sources remain visible and cannot be enabled", async () => {
  const current = await fixture();
  const { service } = createService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await fs.unlink(path.join(current.packageRoot, "SKILL.md"));
  const snapshot = await service.snapshot();
  assert.ok(snapshot.capabilities[0].diagnostics.some((item) => item.code === "skill-source-missing"));
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-source-missing",
  );
});

test("enable requires the host scope while import stays local", async () => {
  const current = await fixture();
  const { service } = createService({ dataRoot: current.dataRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await assert.rejects(
    () => service.setEnabled({ id: "weather.demo", enabled: true }),
    (error) => error?.code === "external-project-missing" && /Suzu 的 DSH 运行时/u.test(error.message),
  );
});

test("remove calls the supplied adapter for each installed host scope", async () => {
  const current = await fixture();
  const { registration, service } = createService({ dataRoot: current.dataRoot, projectRoot: current.projectRoot });
  await service.importManifest({ manifestPath: current.manifestPath });
  await service.setEnabled({ id: "weather.demo", enabled: true });
  const result = await service.remove({ id: "weather.demo", confirmed: true });
  assert.equal(result.removed, true);
  assert.equal(registration.calls.remove.length, 1);
  assert.equal(result.snapshot.capabilities.length, 0);
});

test("adoption writes the new host before replacing only matching legacy installation rows", async () => {
  const current = await fixture();
  const legacyProjectRoot = path.join(path.dirname(current.projectRoot), "legacy-contact");
  await fs.mkdir(legacyProjectRoot, { recursive: true });
  const registration = createRegistrationAdapter();
  const legacy = createExternalCapabilitiesService({
    dataRoot: current.dataRoot,
    projectRoot: legacyProjectRoot,
    registrationAdapter: registration.adapter,
    scopeLabel: "旧 Claude 联系人",
  });
  await legacy.importManifest({ manifestPath: current.manifestPath });
  await legacy.setEnabled({ id: "weather.demo", enabled: true });

  const target = createExternalCapabilitiesService({
    dataRoot: current.dataRoot,
    projectRoot: current.projectRoot,
    registrationAdapter: registration.adapter,
    scopeLabel: "DSH 运行时",
  });
  const adopted = await target.adoptInstallations({ legacyProjectRoots: [legacyProjectRoot] });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.migratedCapabilities, 1);
  assert.equal(registration.calls.write.length, 2);

  const registry = JSON.parse(await fs.readFile(path.join(current.dataRoot, "external-capabilities", "registry.json"), "utf8"));
  const installations = registry.capabilities["weather.demo"].installations;
  assert.deepEqual(Object.keys(installations), [path.resolve(current.projectRoot).toLowerCase()]);
  assert.equal(installations[path.resolve(current.projectRoot).toLowerCase()].projectRoot, current.projectRoot);
});

test("adoption preserves the legacy host's enabled adapter types", async () => {
  const current = await fixture();
  const legacyProjectRoot = path.join(path.dirname(current.projectRoot), "legacy-skill-only-contact");
  await fs.mkdir(legacyProjectRoot, { recursive: true });
  const registration = createRegistrationAdapter();
  const legacy = createExternalCapabilitiesService({
    dataRoot: current.dataRoot,
    projectRoot: legacyProjectRoot,
    registrationAdapter: registration.adapter,
    scopeLabel: "旧 Claude 联系人",
  });
  await legacy.importManifest({ manifestPath: current.manifestPath });
  await legacy.setEnabled({ id: "weather.demo", enabled: true });

  const registryPath = path.join(current.dataRoot, "external-capabilities", "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  registry.capabilities["weather.demo"].installations[path.resolve(legacyProjectRoot).toLowerCase()].types = ["skill"];
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  const target = createExternalCapabilitiesService({
    dataRoot: current.dataRoot,
    projectRoot: current.projectRoot,
    registrationAdapter: registration.adapter,
    scopeLabel: "DSH 运行时",
  });
  await target.adoptInstallations({ legacyProjectRoots: [legacyProjectRoot] });
  const write = registration.calls.write.at(-1);
  assert.ok(write.skill);
  assert.equal(write.mcp, null);

  const after = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.deepEqual(
    after.capabilities["weather.demo"].installations[path.resolve(current.projectRoot).toLowerCase()].types,
    ["skill"],
  );
});
