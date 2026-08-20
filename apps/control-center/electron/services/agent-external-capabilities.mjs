import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SUZU_AGENT_EXTERNAL_CAPABILITIES_PATCH_FILENAME = "suzu-external-capabilities.cordis.patch.yml";

const STATE_FILENAME = ".suzu-external-capabilities.json";
const SKILLS_DIRECTORY = "skills";
const SKILL_METADATA_FILENAME = ".suzu-lives-external-capability.json";
const STATE_VERSION = 1;
const SKILL_METADATA_VERSION = 1;
const CAPABILITY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;

export class AgentExternalCapabilityRegistrationError extends Error {
  constructor(message, { cause, code = "AGENT_EXTERNAL_CAPABILITY_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AgentExternalCapabilityRegistrationError";
    this.code = code;
  }
}


function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredHome(value) {
  const home = clean(value);
  if (!home || !path.isAbsolute(home)) {
    throw new AgentExternalCapabilityRegistrationError("Agent Core 外部能力目录必须是绝对路径。", { code: "AGENT_EXTERNAL_HOME_INVALID" });
  }
  return path.resolve(home);
}

function capabilityId(value) {
  const id = clean(value).toLowerCase();
  if (!CAPABILITY_ID.test(id)) {
    throw new AgentExternalCapabilityRegistrationError("外部能力 ID 无效。", { code: "AGENT_EXTERNAL_CAPABILITY_ID_INVALID" });
  }
  return id;
}

function contained(root, target, label) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentExternalCapabilityRegistrationError(`${label}超出了 Suzu 管理的 Agent Core 运行时目录。`, { code: "AGENT_EXTERNAL_PATH_ESCAPE" });
  }
  return resolved;
}

function safeRelativePath(value) {
  const source = String(value ?? "");
  if (!source || source.length > 1_000 || source.includes("\\") || source.includes("\u0000") || path.posix.isAbsolute(source) || path.win32.isAbsolute(source)) {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 文件路径无效。", { code: "AGENT_EXTERNAL_SKILL_INVALID" });
  }
  const parts = source.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 文件路径不能离开能力目录。", { code: "AGENT_EXTERNAL_SKILL_INVALID" });
  }
  const normalized = parts.join("/");
  if (normalized === SKILL_METADATA_FILENAME) {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 不能覆盖 Suzu 的受管标记文件。", { code: "AGENT_EXTERNAL_SKILL_INVALID" });
  }
  return normalized;
}

function byteContent(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new AgentExternalCapabilityRegistrationError(`${label}不是普通文件内容。`, { code: "AGENT_EXTERNAL_SKILL_INVALID" });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function configurationHash(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

async function lstatOrNull(fsOps, target) {
  try { return await fsOps.lstat(target); }
  catch (error) {
    if (clean(error?.code) === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(fsOps, root, segments) {
  let current = root;
  const rootStat = await lstatOrNull(fsOps, root);
  if (!rootStat) {
    await fsOps.mkdir(root, { recursive: true });
  }
  const afterRoot = await lstatOrNull(fsOps, root);
  if (!afterRoot || afterRoot.isSymbolicLink() || !afterRoot.isDirectory()) {
    throw new AgentExternalCapabilityRegistrationError("Agent Core 外部能力根目录不安全。", { code: "AGENT_EXTERNAL_HOME_UNSAFE" });
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes(path.sep)) {
      throw new AgentExternalCapabilityRegistrationError("Agent Core 外部能力目录段无效。", { code: "AGENT_EXTERNAL_PATH_INVALID" });
    }
    current = contained(root, path.join(current, segment), "Agent Core 外部能力目录");
    let stat = await lstatOrNull(fsOps, current);
    if (!stat) {
      await fsOps.mkdir(current);
      stat = await lstatOrNull(fsOps, current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AgentExternalCapabilityRegistrationError("Agent Core 外部能力目录不安全。", { code: "AGENT_EXTERNAL_DIRECTORY_UNSAFE" });
    }
  }
  return current;
}

async function ordinaryFile(fsOps, root, target, label) {
  if (!contained(root, target, label)) return null;
  const stat = await lstatOrNull(fsOps, target);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AgentExternalCapabilityRegistrationError(`${label}不是可安全使用的普通文件。`, { code: "AGENT_EXTERNAL_FILE_UNSAFE" });
  }
  return stat;
}

async function readOptionalText(fsOps, root, target, label) {
  if (!await ordinaryFile(fsOps, root, target, label)) return null;
  return fsOps.readFile(target, "utf8");
}

async function readOptionalBytes(fsOps, root, target, label) {
  if (!await ordinaryFile(fsOps, root, target, label)) return null;
  const value = await fsOps.readFile(target);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function writeAtomic(fsOps, root, target, content, label) {
  const parent = path.dirname(target);
  const relative = path.relative(root, parent);
  await ensureDirectory(fsOps, root, relative ? relative.split(path.sep).filter(Boolean) : []);
  await ordinaryFile(fsOps, root, target, label);
  const temporary = contained(root, path.join(parent, `.${path.basename(target)}.suzu-${randomUUID()}.tmp`), label);
  try {
    await fsOps.writeFile(temporary, content, { flag: "wx" });
    await fsOps.rename(temporary, target);
  } catch (error) {
    await fsOps.rm(temporary, { force: true }).catch(() => undefined);
    throw new AgentExternalCapabilityRegistrationError(`无法写入${label}。`, { cause: error, code: "AGENT_EXTERNAL_WRITE_FAILED" });
  }
}

async function removeOwnedFile(fsOps, root, target, expectedHash, label) {
  const content = await readOptionalBytes(fsOps, root, target, label);
  if (content === null) {
    throw new AgentExternalCapabilityRegistrationError(`${label}已被删除或手动修改，未删除其他文件。`, { code: "AGENT_EXTERNAL_FILE_MODIFIED" });
  }
  if (sha256(content) !== expectedHash) {
    throw new AgentExternalCapabilityRegistrationError(`${label}已被手动修改，未删除其他文件。`, { code: "AGENT_EXTERNAL_FILE_MODIFIED" });
  }
  await fsOps.rm(target, { force: false, maxRetries: 2, retryDelay: 100 });
}

function skillDirectoryName(id) {
  return `suzu-external-${id}`;
}

function statePath(home) {
  return path.join(home, STATE_FILENAME);
}

function patchPath(home) {
  return path.join(home, SUZU_AGENT_EXTERNAL_CAPABILITIES_PATCH_FILENAME);
}

function skillDirectory(home, id) {
  return path.join(home, SKILLS_DIRECTORY, skillDirectoryName(id));
}

function parseMetadata(content, id) {
  let value;
  try { value = JSON.parse(String(content ?? "")); }
  catch {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 的受管标记不是有效 JSON。", { code: "AGENT_EXTERNAL_SKILL_CONFLICT" });
  }
  const source = plainObject(value);
  if (source.schemaVersion !== SKILL_METADATA_VERSION || clean(source.capabilityId) !== id || !plainObject(source.files)) {
    throw new AgentExternalCapabilityRegistrationError("同名外部 Skill 不属于 Suzu 受管内容。", { code: "AGENT_EXTERNAL_SKILL_CONFLICT" });
  }
  const files = {};
  for (const [key, valueHash] of Object.entries(source.files)) {
    const relativePath = safeRelativePath(key);
    if (relativePath !== key || !/^[a-f0-9]{64}$/u.test(clean(valueHash)) || Object.hasOwn(files, relativePath)) {
      throw new AgentExternalCapabilityRegistrationError("外部 Skill 受管标记无效。", { code: "AGENT_EXTERNAL_SKILL_CONFLICT" });
    }
    files[relativePath] = clean(valueHash);
  }
  if (!Object.hasOwn(files, "SKILL.md")) {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 受管标记缺少 SKILL.md。", { code: "AGENT_EXTERNAL_SKILL_CONFLICT" });
  }
  return { files, version: clean(source.version) };
}

function normalizeSkillFiles(skill) {
  if (!skill || !Array.isArray(skill.files)) {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 安装内容无效。", { code: "AGENT_EXTERNAL_SKILL_INVALID" });
  }
  const files = {};
  for (const source of skill.files) {
    const relativePath = safeRelativePath(source?.relativePath);
    if (Object.hasOwn(files, relativePath)) {
      throw new AgentExternalCapabilityRegistrationError("外部 Skill 包包含重复文件。", { code: "AGENT_EXTERNAL_SKILL_INVALID" });
    }
    files[relativePath] = byteContent(source?.content, `外部 Skill 文件 ${relativePath}`);
  }
  if (!Object.hasOwn(files, "SKILL.md")) {
    throw new AgentExternalCapabilityRegistrationError("外部 Skill 包必须包含 SKILL.md。", { code: "AGENT_EXTERNAL_SKILL_INVALID" });
  }
  return files;
}

async function verifySkillFiles(fsOps, home, folder, metadata) {
  for (const [relativePath, expectedHash] of Object.entries(metadata.files)) {
    const target = contained(folder, path.join(folder, ...relativePath.split("/")), "外部 Skill 文件");
    const content = await readOptionalBytes(fsOps, home, target, `外部 Skill 文件 ${relativePath}`);
    if (content === null || sha256(content) !== expectedHash) {
      throw new AgentExternalCapabilityRegistrationError(`已登记的外部 Skill 文件 ${relativePath} 被删除或手动修改。`, { code: "AGENT_EXTERNAL_SKILL_MODIFIED" });
    }
  }
}

async function writeSkill(fsOps, home, { capabilityId: id, version, skill }) {
  const files = normalizeSkillFiles(skill);
  const folder = await ensureDirectory(fsOps, home, [SKILLS_DIRECTORY, skillDirectoryName(id)]);
  const metadataPath = contained(home, path.join(folder, SKILL_METADATA_FILENAME), "外部 Skill 受管标记");
  const existingMetadataContent = await readOptionalText(fsOps, home, metadataPath, "外部 Skill 受管标记");
  const existing = existingMetadataContent === null ? null : parseMetadata(existingMetadataContent, id);
  if (existing) await verifySkillFiles(fsOps, home, folder, existing);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = contained(folder, path.join(folder, ...relativePath.split("/")), "外部 Skill 文件");
    const previous = await readOptionalBytes(fsOps, home, target, `外部 Skill 文件 ${relativePath}`);
    if (previous !== null && !existing?.files?.[relativePath]) {
      throw new AgentExternalCapabilityRegistrationError(`目标外部 Skill 文件 ${relativePath} 不属于 Suzu，未覆盖。`, { code: "AGENT_EXTERNAL_SKILL_CONFLICT" });
    }
    if (previous === null || !previous.equals(content)) await writeAtomic(fsOps, home, target, content, `外部 Skill 文件 ${relativePath}`);
  }
  // Only product-hashed obsolete files are removed; a user-added file inside
  // the same package directory is deliberately left alone.
  for (const [relativePath, hash] of Object.entries(existing?.files || {})) {
    if (Object.hasOwn(files, relativePath)) continue;
    const target = contained(folder, path.join(folder, ...relativePath.split("/")), "外部 Skill 文件");
    await removeOwnedFile(fsOps, home, target, hash, `外部 Skill 文件 ${relativePath}`);
  }
  const metadata = {
    schemaVersion: SKILL_METADATA_VERSION,
    capabilityId: id,
    version: clean(version),
    files: Object.fromEntries(Object.entries(files).map(([relativePath, content]) => [relativePath, sha256(content)])),
  };
  await writeAtomic(fsOps, home, metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "外部 Skill 受管标记");
  return { registered: true, version: metadata.version, directory: folder };
}

async function removeSkill(fsOps, home, id) {
  const folder = skillDirectory(home, id);
  const metadataPath = contained(home, path.join(folder, SKILL_METADATA_FILENAME), "外部 Skill 受管标记");
  const content = await readOptionalText(fsOps, home, metadataPath, "外部 Skill 受管标记");
  const skillPath = contained(home, path.join(folder, "SKILL.md"), "外部 SKILL.md");
  if (content === null) {
    if (await readOptionalBytes(fsOps, home, skillPath, "外部 SKILL.md") !== null) {
      throw new AgentExternalCapabilityRegistrationError("当前同名外部 SKILL.md 不属于 Suzu，未移除。", { code: "AGENT_EXTERNAL_SKILL_CONFLICT" });
    }
    return { removed: false };
  }
  const metadata = parseMetadata(content, id);
  await verifySkillFiles(fsOps, home, folder, metadata);
  for (const [relativePath, hash] of Object.entries(metadata.files)) {
    const target = contained(folder, path.join(folder, ...relativePath.split("/")), "外部 Skill 文件");
    await removeOwnedFile(fsOps, home, target, hash, `外部 Skill 文件 ${relativePath}`);
  }
  await fsOps.rm(metadataPath, { force: false, maxRetries: 2, retryDelay: 100 });
  return { removed: true };
}

function normalizeMcpConfiguration(value) {
  const source = plainObject(value);
  const type = clean(source.type).toLowerCase();
  if (type === "stdio") {
    const command = clean(source.command);
    const args = Array.isArray(source.args) ? source.args.map((item) => String(item)) : [];
    const env = plainObject(source.env);
    if (!command) throw new AgentExternalCapabilityRegistrationError("外部 MCP 缺少启动命令。", { code: "AGENT_EXTERNAL_MCP_INVALID" });
    return {
      type,
      command,
      args,
      ...(Object.keys(env).length ? { env: Object.fromEntries(Object.entries(env).map(([key, item]) => [key, String(item)])) } : {}),
    };
  }
  if (type === "http") {
    const url = clean(source.url);
    const headers = plainObject(source.headers);
    if (!url) throw new AgentExternalCapabilityRegistrationError("外部 MCP 缺少服务地址。", { code: "AGENT_EXTERNAL_MCP_INVALID" });
    return {
      type,
      url,
      ...(Object.keys(headers).length ? { headers: Object.fromEntries(Object.entries(headers).map(([key, item]) => [key, String(item)])) } : {}),
    };
  }
  throw new AgentExternalCapabilityRegistrationError("外部 MCP 传输类型无效。", { code: "AGENT_EXTERNAL_MCP_INVALID" });
}

function serverName(id) {
  return `suzu_${sha256(id).slice(0, 12)}`;
}

function yamlValue(value) {
  const source = String(value);
  const environment = ENVIRONMENT_REFERENCE.exec(source);
  return environment ? `!!js process.env.${environment[1]}` : JSON.stringify(source);
}

function renderMcpEntry(id, record) {
  const configuration = normalizeMcpConfiguration(record?.mcp?.configuration);
  const hash = sha256(id).slice(0, 16);
  const lines = [
    `- id: suzu-external-mcp-${hash}`,
    "  name: '@suzu-lives/suzu-agent-runtime/core/mcp-client'",
    "  config:",
    `    serverName: ${JSON.stringify(clean(record?.mcp?.serverName) || serverName(id))}`,
    `    transport: ${configuration.type === "http" ? "streamable-http" : "stdio"}`,
  ];
  if (configuration.type === "stdio") {
    lines.push(`    command: ${yamlValue(configuration.command)}`);
    if (configuration.args.length) {
      lines.push("    args:");
      for (const argument of configuration.args) lines.push(`      - ${yamlValue(argument)}`);
    }
    if (configuration.env && Object.keys(configuration.env).length) {
      lines.push("    env:");
      for (const [key, value] of Object.entries(configuration.env).sort(([left], [right]) => left.localeCompare(right, "en"))) {
        lines.push(`      ${key}: ${yamlValue(value)}`);
      }
    }
  } else {
    lines.push(`    url: ${yamlValue(configuration.url)}`);
    if (configuration.headers && Object.keys(configuration.headers).length) {
      lines.push("    headers:");
      for (const [key, value] of Object.entries(configuration.headers).sort(([left], [right]) => left.localeCompare(right, "en"))) {
        lines.push(`      ${JSON.stringify(key)}: ${yamlValue(value)}`);
      }
    }
  }
  return lines.join("\n");
}

function normalizeState(value) {
  const source = plainObject(value);
  if (source.schemaVersion !== STATE_VERSION || !plainObject(source.capabilities)) {
    throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 登记文件格式无效。", { code: "AGENT_EXTERNAL_STATE_INVALID" });
  }
  const capabilities = {};
  for (const [rawId, rawRecord] of Object.entries(source.capabilities)) {
    const id = capabilityId(rawId);
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
      throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 登记内容无效。", { code: "AGENT_EXTERNAL_STATE_INVALID" });
    }
    const record = rawRecord;
    const mcp = record.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp) || !mcp.configuration || typeof mcp.configuration !== "object" || Array.isArray(mcp.configuration) || clean(mcp.configurationHash) !== configurationHash(mcp.configuration)) {
      throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 登记内容无效。", { code: "AGENT_EXTERNAL_STATE_INVALID" });
    }
    const name = clean(mcp.serverName);
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) {
      throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 服务名无效。", { code: "AGENT_EXTERNAL_STATE_INVALID" });
    }
    capabilities[id] = {
      version: clean(record.version),
      mcp: {
        configuration: normalizeMcpConfiguration(mcp.configuration),
        configurationHash: clean(mcp.configurationHash),
        serverName: name,
      },
    };
  }
  return { schemaVersion: STATE_VERSION, capabilities };
}

async function readState(fsOps, home) {
  const content = await readOptionalText(fsOps, home, statePath(home), "Agent Core 外部 MCP 登记文件");
  if (content === null) return { schemaVersion: STATE_VERSION, capabilities: {} };
  try { return normalizeState(JSON.parse(content)); }
  catch (error) {
    if (error instanceof AgentExternalCapabilityRegistrationError) throw error;
    throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 登记文件不是有效 JSON。", { cause: error, code: "AGENT_EXTERNAL_STATE_INVALID" });
  }
}

function renderPatch(state) {
  const entries = Object.entries(state.capabilities)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([id, record]) => renderMcpEntry(id, record));
  return entries.length
    ? `# Suzu-managed Agent Core external MCP capabilities. Do not edit by hand.\n${entries.join("\n\n")}\n`
    : "# Suzu-managed Agent Core external MCP capabilities. Do not edit by hand.\n[]\n";
}

async function assertPatchMatchesState(fsOps, home, state, { allowMissing = true } = {}) {
  const content = await readOptionalText(fsOps, home, patchPath(home), "Agent Core 外部 MCP 配置补丁");
  if (content === null) {
    if (allowMissing) return false;
    throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 配置补丁缺失。", { code: "AGENT_EXTERNAL_PATCH_MISSING" });
  }
  if (content !== renderPatch(state)) {
    throw new AgentExternalCapabilityRegistrationError("Agent Core 外部 MCP 配置补丁被手动修改，未覆盖。", { code: "AGENT_EXTERNAL_PATCH_MODIFIED" });
  }
  return true;
}

async function writeStateAndPatch(fsOps, home, state) {
  const stateContent = `${JSON.stringify(state, null, 2)}\n`;
  const patchContent = renderPatch(state);
  await writeAtomic(fsOps, home, statePath(home), stateContent, "Agent Core 外部 MCP 登记文件");
  await writeAtomic(fsOps, home, patchPath(home), patchContent, "Agent Core 外部 MCP 配置补丁");
}

export async function ensureSuzuAgentExternalCapabilitiesPatch({ runtimeHome, fsOps = fs } = {}) {
  const home = requiredHome(runtimeHome);
  await ensureDirectory(fsOps, home, []);
  const state = await readState(fsOps, home);
  const exists = await assertPatchMatchesState(fsOps, home, state, { allowMissing: true });
  if (!exists) await writeAtomic(fsOps, home, patchPath(home), renderPatch(state), "Agent Core 外部 MCP 配置补丁");
  return Object.freeze({ patchFile: patchPath(home), runtimeHome: home });
}

/**
 * Product-owned registration adapter for the generic local manifest registry.
 * Skills live under Agent Core's documented user skill root and MCP rows live in a
 * separate Suzu overlay passed to the owned Agent Core process. No external project
 * file or third-party process is touched during import.
 */
export function createAgentExternalCapabilityRegistration({ runtimeHome, fsOps = fs, onChanged = null } = {}) {
  const home = requiredHome(runtimeHome);
  let queue = Promise.resolve();
  const serialized = (action) => {
    const task = queue.catch(() => undefined).then(action);
    queue = task.catch(() => undefined);
    return task;
  };
  const changed = async () => {
    if (typeof onChanged === "function") await onChanged();
  };

  const inspectSkill = async (id) => {
    const folder = skillDirectory(home, id);
    const metadataPath = contained(home, path.join(folder, SKILL_METADATA_FILENAME), "外部 Skill 受管标记");
    const metadataContent = await readOptionalText(fsOps, home, metadataPath, "外部 Skill 受管标记");
    const skillPath = contained(home, path.join(folder, "SKILL.md"), "外部 SKILL.md");
    if (metadataContent === null) {
      if (await readOptionalBytes(fsOps, home, skillPath, "外部 SKILL.md") !== null) {
        return { registered: false, reason: "当前同名外部 SKILL.md 不属于 Suzu。", version: "" };
      }
      return { registered: false, reason: "Agent Core 运行时没有这项外部 Skill 的受管登记。", version: "" };
    }
    try {
      const metadata = parseMetadata(metadataContent, id);
      await verifySkillFiles(fsOps, home, folder, metadata);
      return { registered: true, reason: "Agent Core 运行时已登记这项外部 Skill。", version: metadata.version };
    } catch (error) {
      return { registered: false, reason: clean(error?.message) || "外部 Skill 受管标记无效。", version: "" };
    }
  };

  const inspectMcp = async (id) => {
    try {
      const state = await readState(fsOps, home);
      await assertPatchMatchesState(fsOps, home, state, { allowMissing: false });
      const record = state.capabilities[id];
      if (!record?.mcp) return { registered: false, reason: "Agent Core 运行时没有这项外部 MCP 的受管登记。", version: "" };
      return { registered: true, reason: "Agent Core 运行时已登记这项外部 MCP。", version: clean(record.version) };
    } catch (error) {
      return { registered: false, reason: clean(error?.message) || "Agent Core 外部 MCP 登记无效。", version: "" };
    }
  };

  return Object.freeze({
    async inspect({ capabilityId: rawId, types = [] } = {}) {
      const id = capabilityId(rawId);
      const requested = new Set(Array.isArray(types) ? types : []);
      const [skill, mcp] = await Promise.all([
        requested.has("skill") ? inspectSkill(id) : null,
        requested.has("mcp") ? inspectMcp(id) : null,
      ]);
      return {
        capabilityId: id,
        skill,
        mcp,
        registered: [skill, mcp].filter(Boolean).every((item) => item.registered === true),
      };
    },

    async write({ capabilityId: rawId, version, skill = null, mcp = null } = {}) {
      return serialized(async () => {
        const id = capabilityId(rawId);
        if (!skill && !mcp) {
          throw new AgentExternalCapabilityRegistrationError("外部能力至少需要一个 Skill 或 MCP 适配器。", { code: "AGENT_EXTERNAL_CAPABILITY_EMPTY" });
        }
        await ensureSuzuAgentExternalCapabilitiesPatch({ runtimeHome: home, fsOps });
        const registered = {};
        if (skill) registered.skill = await writeSkill(fsOps, home, { capabilityId: id, version, skill });
        if (mcp) {
          const state = await readState(fsOps, home);
          await assertPatchMatchesState(fsOps, home, state, { allowMissing: false });
          const configuration = normalizeMcpConfiguration(mcp.configuration);
          state.capabilities[id] = {
            version: clean(version),
            mcp: {
              configuration,
              configurationHash: configurationHash(configuration),
              serverName: serverName(id),
            },
          };
          await writeStateAndPatch(fsOps, home, state);
          registered.mcp = { registered: true, serverName: state.capabilities[id].mcp.serverName };
        }
        await changed();
        return { capabilityId: id, registration: registered, runtimeHome: home };
      });
    },

    async remove({ capabilityId: rawId, types = [] } = {}) {
      return serialized(async () => {
        const id = capabilityId(rawId);
        const requested = new Set(Array.isArray(types) ? types : []);
        await ensureSuzuAgentExternalCapabilitiesPatch({ runtimeHome: home, fsOps });
        const removed = {};
        if (requested.has("skill")) removed.skill = await removeSkill(fsOps, home, id);
        if (requested.has("mcp")) {
          const state = await readState(fsOps, home);
          await assertPatchMatchesState(fsOps, home, state, { allowMissing: false });
          if (state.capabilities[id]) {
            delete state.capabilities[id];
            await writeStateAndPatch(fsOps, home, state);
            removed.mcp = { removed: true };
          } else {
            removed.mcp = { removed: false };
          }
        }
        await changed();
        return { capabilityId: id, removed: Object.values(removed).some((item) => item.removed === true), registration: removed, runtimeHome: home };
      });
    },
  });
}
