import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Session } from "@suzu-lives/suzu-agent-runtime/core/session";

import {
  createLegacyMigrationService,
  legacyClaudeProjectDirectoryCandidates,
  parseNativeAgentSessionArtifact,
} from "../electron/services/legacy-migration-service.mjs";
import { resolveAgentSessionStoragePaths } from "../electron/services/agent-session-storage.mjs";
import { resolveSuzuAgentRuntimePaths } from "../electron/services/suzu-agent-runtime.mjs";

const TEST_ROOT = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp\\suzu-lives-migrator-tests";

async function temporaryDirectory(prefix) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TEST_ROOT, prefix));
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function jsonHash(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

async function legacyFixture() {
  const root = await temporaryDirectory("full-");
  const dataRoot = path.join(root, "data");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const contactId = "contact-11111111-1111-4111-8111-111111111111";
  const agentId = "agent-legacy-contact";
  const sessionId = "legacy-session-001";
  const projectRoot = path.join(contactsRoot, contactId);
  const metadataPath = path.join(projectRoot, ".suzu-lives", "contact.json");
  await fs.mkdir(path.join(projectRoot, ".suzu-lives"), { recursive: true });
  await writeJson(metadataPath, {
    version: 1,
    id: contactId,
    name: "旧联系人",
    createdAt: "2026-08-01T00:00:00.000Z",
    sessionId,
    agentId,
    approvalMode: "bypassPermissions",
  });
  await fs.writeFile(path.join(projectRoot, "CLAUDE.md"), "# 给旧联系人的说明\n@abilities.md\n", "utf8");
  await fs.writeFile(
    path.join(projectRoot, "abilities.md"),
    "<!-- suzu-lives:abilities:start -->\n旧版受管能力\n<!-- suzu-lives:abilities:end -->\n",
    "utf8",
  );
  await fs.mkdir(path.join(projectRoot, ".claude", "skills", "image-generation"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".claude", "skills", "image-generation", "SKILL.md"),
    "<!-- suzu-lives:ability:image-generation -->\n旧版能力\n",
    "utf8",
  );
  await writeJson(path.join(projectRoot, ".claude", "settings.json"), {
    hooks: {
      UserPromptSubmit: [{
        hooks: [
          { type: "command", args: ["--suzu-lives-hook", "time-awareness"] },
          { type: "command", args: ["keep-user-hook"] },
        ],
      }],
    },
  });

  const externalSkill = "---\nname: weather-demo\n---\n\n旧版外部 Skill\n";
  const externalSkillDirectory = path.join(projectRoot, ".claude", "skills", "suzu-external-weather.demo");
  await fs.mkdir(externalSkillDirectory, { recursive: true });
  await fs.writeFile(path.join(externalSkillDirectory, "SKILL.md"), externalSkill, "utf8");
  await writeJson(path.join(externalSkillDirectory, ".suzu-lives-external-capability.json"), {
    schemaVersion: 2,
    capabilityId: "weather.demo",
    version: "1.0.0",
    files: { "SKILL.md": sha256(externalSkill) },
  });
  const externalServer = { command: "node", args: ["server.mjs"] };
  await writeJson(path.join(projectRoot, ".mcp.json"), {
    mcpServers: {
      "suzu-external-weather.demo": externalServer,
      "keep-user-server": { command: "keep" },
    },
  });
  await writeJson(path.join(projectRoot, ".claude", "suzu-lives-external-capabilities.json"), {
    schemaVersion: 1,
    entries: {
      "weather.demo": {
        serverName: "suzu-external-weather.demo",
        configurationSha256: jsonHash(externalServer),
      },
    },
  });

  const transcriptDirectory = legacyClaudeProjectDirectoryCandidates({ projectRoot, homeDirectory })[0];
  await fs.mkdir(transcriptDirectory, { recursive: true });
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
  await fs.writeFile(transcriptPath, [
    { type: "user", timestamp: "2026-08-02T00:00:00.000Z", message: { content: "你好，小苏。" } },
    { type: "assistant", timestamp: "2026-08-02T00:00:01.000Z", message: { model: "claude-test", content: [{ type: "text", text: "你好，我在。" }] } },
    { type: "user", isMeta: true, message: { content: "这条是恢复元信息" } },
    { type: "assistant", message: { model: "<synthetic>", content: "NO_REPLY" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  const unrelatedTranscript = path.join(homeDirectory, ".claude", "projects", "unrelated-project", "unrelated.jsonl");
  await fs.mkdir(path.dirname(unrelatedTranscript), { recursive: true });
  await fs.writeFile(unrelatedTranscript, "{\"type\":\"user\"}\n", "utf8");
  await fs.writeFile(path.join(homeDirectory, ".claude", "config.json"), "keep-global-claude-state", "utf8");

  const oldCompactorPath = path.join(dataRoot, "agents", agentId, "conversations", sessionId, "compactor.json");
  await writeJson(oldCompactorPath, {
    version: 1,
    prompt: "旧版压缩提示词",
    automatic: { enabled: true, tokenThreshold: 12_000, retainTokens: 4_000 },
    manual: { retainTokens: 3_000 },
    updatedAt: "2026-08-03T00:00:00.000Z",
  });
  const memoryPath = path.join(dataRoot, "agents", agentId, "memory", "sessions", sessionId, "suzu-memory.db");
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, "legacy-memory-sentinel", "utf8");
  await writeJson(path.join(dataRoot, "connections", "dashscope.json"), {
    baseUrl: "https://dashscope.example.test/v1",
    encryptedApiKey: "opaque-legacy-ciphertext",
  });
  // Image and video deliberately share one old key and endpoint but use
  // different models. The importer must keep those as separate named
  // connections rather than silently pointing both capabilities at one model.
  await writeJson(path.join(dataRoot, "connections", "image-vision.json"), {
    encryptedApiKey: "opaque-media-ciphertext",
  });
  await writeJson(path.join(dataRoot, "capabilities", "image-vision", "config.json"), {
    openai: { base_url: "https://media.example.test/v1", model: "fallback-vision-model" },
    vision: { detail: "high", base_url: "https://media.example.test/v1", model: "vision-model" },
  });
  await writeJson(path.join(dataRoot, "connections", "video-understanding.json"), {
    encryptedApiKey: "opaque-media-ciphertext",
  });
  await writeJson(path.join(dataRoot, "capabilities", "video-understanding", "config.json"), {
    provider: { base_url: "https://media.example.test/v1", model: "video-model" },
    video: { fps: 2 },
  });
  await writeJson(path.join(dataRoot, "settings.json"), {
    contactsRoot,
    projectRoot,
    claudeToolPermissions: { read: true },
    claudeRuntimeFeatures: { hooks: true },
    claudeProjectDefaults: { allowedTools: ["Read"] },
  });

  return {
    dataRoot,
    contactsRoot,
    homeDirectory,
    contactId,
    agentId,
    sessionId,
    projectRoot,
    metadataPath,
    transcriptPath,
    unrelatedTranscript,
    oldCompactorPath,
    memoryPath,
  };
}

test("one-time migrator converts a Suzu-owned Claude contact into native Agent Core data", async () => {
  const fixture = await legacyFixture();
  let savedSettings = null;
  const settingsService = {
    load: () => ({ contactsRoot: fixture.contactsRoot, projectRoot: fixture.projectRoot, theme: "light" }),
    save: async (value) => { savedSettings = value; return value; },
  };
  const migration = createLegacyMigrationService({
    dataRoot: fixture.dataRoot,
    homeDirectory: fixture.homeDirectory,
    settingsService,
    adoptExternalCapabilities: async ({ legacyProjectRoots }) => ({
      adopted: true,
      registrations: [{ id: "weather.demo", types: ["skill", "mcp"], sourceProjectRoots: legacyProjectRoots }],
    }),
  });

  const inspection = await migration.inspect();
  assert.equal(inspection.status, "ready");
  assert.equal(inspection.totals.contacts, 1);
  assert.equal(inspection.totals.nativeTranscriptImports, 1);
  assert.equal(inspection.totals.compatibleMemoryDatabases, 1);
  assert.equal(inspection.totals.connections, 3);

  const result = await migration.migrate();
  assert.equal(result.status, "completed");
  assert.deepEqual(savedSettings, { contactsRoot: fixture.contactsRoot, projectRoot: fixture.projectRoot, theme: "light" });
  assert.equal(await fs.readFile(path.join(fixture.projectRoot, "SUZU.md"), "utf8"), "# 给旧联系人的说明\n");
  await assert.rejects(fs.stat(path.join(fixture.projectRoot, "CLAUDE.md")), /ENOENT/u);
  await assert.rejects(fs.stat(path.join(fixture.projectRoot, "abilities.md")), /ENOENT/u);
  const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, "utf8"));
  assert.equal(Object.hasOwn(metadata, "approvalMode"), false);
  const hooks = JSON.parse(await fs.readFile(path.join(fixture.projectRoot, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(hooks.hooks.UserPromptSubmit[0].hooks, [{ type: "command", args: ["keep-user-hook"] }]);
  await assert.rejects(fs.stat(path.join(fixture.projectRoot, ".claude", "skills", "image-generation", "SKILL.md")), /ENOENT/u);

  const paths = resolveAgentSessionStoragePaths({
    runtimeHome: resolveSuzuAgentRuntimePaths({ dataRoot: fixture.dataRoot }).runtimeHome,
    projectRoot: fixture.projectRoot,
    sessionId: fixture.sessionId,
  });
  const nativeSession = await fs.readFile(path.join(paths.sessionDirectory, "session.jsonl.zstd"));
  const { header, events: nativeLines } = parseNativeAgentSessionArtifact(nativeSession, {
    sessionId: fixture.sessionId,
    projectRoot: fixture.projectRoot,
  });
  assert.equal(header.type, "session");
  assert.equal(header.id, fixture.sessionId);
  assert.equal(nativeLines.length, 2);
  assert.equal(nativeLines[0].data.content[0].text, "你好，小苏。");
  assert.equal(nativeLines[1].data.message.content[0].text, "你好，我在。");
  Session.fromRestore(fixture.sessionId, nativeLines, {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    delegationDepth: header.delegationDepth,
    agentPreset: header.agentPreset,
  });
  await assert.rejects(fs.stat(fixture.transcriptPath), /ENOENT/u);
  assert.equal(await fs.readFile(fixture.unrelatedTranscript, "utf8"), "{\"type\":\"user\"}\n");
  assert.equal(await fs.readFile(path.join(fixture.homeDirectory, ".claude", "config.json"), "utf8"), "keep-global-claude-state");

  const compactor = JSON.parse(await fs.readFile(path.join(fixture.projectRoot, ".suzu-lives", "compactor.json"), "utf8"));
  assert.equal(compactor.version, 1);
  assert.equal(Object.hasOwn(compactor.automatic, "trigger"), false);
  assert.equal(Object.hasOwn(compactor.automatic, "time"), false);
  assert.equal(compactor.automatic.tokenThreshold, 12_000);
  await assert.rejects(fs.stat(fixture.oldCompactorPath), /ENOENT/u);
  assert.equal(await fs.readFile(fixture.memoryPath, "utf8"), "legacy-memory-sentinel");
  const namedConnections = JSON.parse(await fs.readFile(path.join(fixture.dataRoot, "connections", "api-connections.json"), "utf8"));
  const dashscope = namedConnections.connections.find((connection) => connection.type === "dashscope");
  const mediaConnections = namedConnections.connections.filter((connection) => connection.type === "openai-compatible");
  assert.equal(dashscope.encryptedApiKey, "opaque-legacy-ciphertext");
  assert.equal(namedConnections.bindings["voice-message"], dashscope.id);
  assert.equal(Object.hasOwn(namedConnections.bindings, "voice-design"), false);
  assert.equal(mediaConnections.length, 2);
  assert.deepEqual(mediaConnections.map((connection) => connection.model).sort(), ["video-model", "vision-model"]);
  assert.notEqual(namedConnections.bindings["image-vision"], namedConnections.bindings["video-understanding"]);
  await assert.rejects(fs.stat(path.join(fixture.dataRoot, "connections", "dashscope.json")), /ENOENT/u);
  await assert.rejects(fs.stat(path.join(fixture.dataRoot, "connections", "image-vision.json")), /ENOENT/u);
  await assert.rejects(fs.stat(path.join(fixture.dataRoot, "connections", "video-understanding.json")), /ENOENT/u);
  const imageVisionConfig = JSON.parse(await fs.readFile(path.join(fixture.dataRoot, "capabilities", "image-vision", "config.json"), "utf8"));
  const videoUnderstandingConfig = JSON.parse(await fs.readFile(path.join(fixture.dataRoot, "capabilities", "video-understanding", "config.json"), "utf8"));
  assert.equal(Object.hasOwn(imageVisionConfig, "openai"), false);
  assert.equal(imageVisionConfig.vision.detail, "high");
  assert.equal(Object.hasOwn(imageVisionConfig.vision, "base_url"), false);
  assert.equal(Object.hasOwn(imageVisionConfig.vision, "model"), false);
  assert.equal(Object.hasOwn(videoUnderstandingConfig, "provider"), false);
  assert.equal(videoUnderstandingConfig.video.fps, 2);

  await assert.rejects(fs.stat(path.join(fixture.projectRoot, ".claude", "skills", "suzu-external-weather.demo")), /ENOENT/u);
  const mcp = JSON.parse(await fs.readFile(path.join(fixture.projectRoot, ".mcp.json"), "utf8"));
  assert.equal(Object.hasOwn(mcp.mcpServers, "suzu-external-weather.demo"), false);
  assert.deepEqual(mcp.mcpServers["keep-user-server"], { command: "keep" });
  await assert.rejects(fs.stat(path.join(fixture.projectRoot, ".claude", "suzu-lives-external-capabilities.json")), /ENOENT/u);
});

test("conflicting SUZU.md leaves every legacy source in place", async () => {
  const fixture = await legacyFixture();
  await fs.writeFile(path.join(fixture.projectRoot, "SUZU.md"), "不同的新说明\n", "utf8");
  const migration = createLegacyMigrationService({
    dataRoot: fixture.dataRoot,
    homeDirectory: fixture.homeDirectory,
    settingsService: { load: () => ({ contactsRoot: fixture.contactsRoot }), save: async (value) => value },
  });

  const result = await migration.migrate();
  assert.equal(result.status, "partial");
  assert.equal(await fs.readFile(path.join(fixture.projectRoot, "CLAUDE.md"), "utf8"), "# 给旧联系人的说明\n@abilities.md\n");
  await fs.stat(fixture.transcriptPath);
  await fs.stat(fixture.oldCompactorPath);
  assert.equal(await fs.readFile(path.join(fixture.projectRoot, "SUZU.md"), "utf8"), "不同的新说明\n");
});

test("a missing old CLAUDE.md does not block an otherwise safe transcript import", async () => {
  const fixture = await legacyFixture();
  await fs.unlink(path.join(fixture.projectRoot, "CLAUDE.md"));
  const migration = createLegacyMigrationService({
    dataRoot: fixture.dataRoot,
    homeDirectory: fixture.homeDirectory,
    settingsService: { load: () => ({ contactsRoot: fixture.contactsRoot }), save: async (value) => value },
  });

  const result = await migration.migrate();
  assert.equal(result.status, "completed");
  assert.equal(result.contacts[0].instructions.status, "missing");
  assert.equal(result.contacts[0].transcript.status, "migrated");
  await assert.rejects(fs.stat(fixture.transcriptPath), /ENOENT/u);
});

test("a malformed legacy JSONL line keeps the original source after importing valid messages", async () => {
  const fixture = await legacyFixture();
  await fs.appendFile(fixture.transcriptPath, "{not valid json}\n", "utf8");
  const migration = createLegacyMigrationService({
    dataRoot: fixture.dataRoot,
    homeDirectory: fixture.homeDirectory,
    settingsService: { load: () => ({ contactsRoot: fixture.contactsRoot }), save: async (value) => value },
  });

  const result = await migration.migrate();
  assert.equal(result.status, "partial");
  assert.equal(result.contacts[0].transcript.status, "migrated-with-retained-source");
  assert.equal(result.contacts[0].transcript.malformedLines, 1);
  await fs.stat(fixture.transcriptPath);
  const paths = resolveAgentSessionStoragePaths({
    runtimeHome: resolveSuzuAgentRuntimePaths({ dataRoot: fixture.dataRoot }).runtimeHome,
    projectRoot: fixture.projectRoot,
    sessionId: fixture.sessionId,
  });
  await fs.stat(path.join(paths.sessionDirectory, "session.jsonl.zstd"));
});

test("an existing native session never causes deletion of an old JSONL", async () => {
  const fixture = await legacyFixture();
  await fs.rename(path.join(fixture.projectRoot, "CLAUDE.md"), path.join(fixture.projectRoot, "SUZU.md"));
  const paths = resolveAgentSessionStoragePaths({
    runtimeHome: resolveSuzuAgentRuntimePaths({ dataRoot: fixture.dataRoot }).runtimeHome,
    projectRoot: fixture.projectRoot,
    sessionId: fixture.sessionId,
  });
  await fs.mkdir(paths.sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(paths.sessionDirectory, "session.jsonl.zstd"), "already-native", "utf8");
  const migration = createLegacyMigrationService({
    dataRoot: fixture.dataRoot,
    homeDirectory: fixture.homeDirectory,
    settingsService: { load: () => ({ contactsRoot: fixture.contactsRoot }), save: async (value) => value },
  });

  const result = await migration.migrate();
  assert.equal(result.contacts[0].transcript.status, "target-exists");
  await fs.stat(fixture.transcriptPath);
  assert.equal(await fs.readFile(path.join(paths.sessionDirectory, "session.jsonl.zstd"), "utf8"), "already-native");
});

test("only exact known Claude Skill ownership markers are cleaned, while an unmapped legacy feature stays intact", async () => {
  const fixture = await legacyFixture();
  const userSkill = path.join(fixture.projectRoot, ".claude", "skills", "user-custom", "SKILL.md");
  const merchantSkill = path.join(fixture.projectRoot, ".claude", "skills", "traveling-merchant", "SKILL.md");
  await fs.mkdir(path.dirname(userSkill), { recursive: true });
  await fs.writeFile(userSkill, "<!-- suzu-lives:ability:image-generation -->\n这是用户自己的同名标记示例。\n", "utf8");
  await fs.mkdir(path.dirname(merchantSkill), { recursive: true });
  await fs.writeFile(merchantSkill, "<!-- suzu-lives:ability:traveling-merchant -->\n旧版旅行商人入口。\n", "utf8");
  const migration = createLegacyMigrationService({
    dataRoot: fixture.dataRoot,
    homeDirectory: fixture.homeDirectory,
    settingsService: { load: () => ({ contactsRoot: fixture.contactsRoot }), save: async (value) => value },
  });

  const result = await migration.migrate();
  assert.equal(result.status, "partial");
  assert.equal(await fs.readFile(userSkill, "utf8"), "<!-- suzu-lives:ability:image-generation -->\n这是用户自己的同名标记示例。\n");
  assert.equal(await fs.readFile(merchantSkill, "utf8"), "<!-- suzu-lives:ability:traveling-merchant -->\n旧版旅行商人入口。\n");
  assert.match(result.warnings.join("\n"), /traveling-merchant/u);
});
