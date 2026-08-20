import fs from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILENAME = "suzu-capability.json";
export const MANIFEST_SCHEMA_VERSION = 1;

const CAPABILITY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_KEY = /^[A-Za-z0-9-]{1,128}$/u;
const REGISTRY_VERSION = 1;
const MAX_MANIFEST_BYTES = 128_000;
const MAX_SKILL_BYTES = 1_000_000;
const MAX_SKILL_PACKAGE_BYTES = 8_000_000;
const MAX_SKILL_PACKAGE_FILES = 256;
const MAX_SKILL_PACKAGE_DEPTH = 16;

export class ExternalCapabilityError extends Error {
  constructor(message, { code = "", details = {} } = {}) {
    super(message);
    this.name = "ExternalCapabilityError";
    this.code = code;
    this.details = details;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fail(message, code = "external-manifest-invalid", details = {}) {
  throw new ExternalCapabilityError(message, { code, details });
}

function boundedText(value, label, { minimum = 0, maximum = 500, allowNewlines = false } = {}) {
  if (typeof value !== "string") fail(`${label}必须是字符串。`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum || /\u0000/u.test(text) || (!allowNewlines && /[\r\n]/u.test(text))) {
    fail(`${label}长度或格式无效。`);
  }
  return text;
}

function assertKnownKeys(value, allowed, label) {
  if (!plainObject(value)) fail(`${label}必须是 JSON 对象。`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label}包含不支持的字段：${unexpected.join("、")}。`);
  return value;
}

function capabilityId(value) {
  const id = boundedText(value, "能力 id", { minimum: 1, maximum: 64 }).toLowerCase();
  if (!CAPABILITY_ID.test(id)) fail("能力 id 只能包含小写字母、数字、点、短横线或下划线，且不能以符号结尾。", "external-manifest-invalid");
  return id;
}

function semanticVersion(value) {
  const version = boundedText(value, "能力版本", { minimum: 1, maximum: 120 });
  if (!SEMVER.test(version)) fail("能力版本必须使用 SemVer，例如 1.0.0。", "external-manifest-invalid");
  return version;
}

function relativePackagePath(value, label) {
  const source = boundedText(value, label, { minimum: 1, maximum: 1_000 });
  if (source.includes("\\") || path.posix.isAbsolute(source) || path.win32.isAbsolute(source)) {
    fail(`${label}必须是能力包内使用 / 的相对路径。`);
  }
  const segments = source.split("/").filter((segment) => segment !== ".");
  if (!segments.length || segments.some((segment) => !segment || segment === "..")) {
    fail(`${label}不能离开能力包目录。`);
  }
  return segments.join("/");
}

function stringList(value, label, { maximumItems = 64, maximumLength = 1_000 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) fail(`${label}必须是不超过 ${maximumItems} 项的字符串数组。`);
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, { maximum: maximumLength }));
}

function mcpCommandToken(value, label) {
  const token = boundedText(value, label, { minimum: 1, maximum: 1_000 });
  if (token === ".." || token.startsWith("../") || token.startsWith(".\\")) {
    fail(`${label}不能使用会离开能力包的相对路径。`);
  }
  if (token.startsWith("./")) return `./${relativePackagePath(token.slice(2), label)}`;
  return token;
}

function stringMap(value, label, keyPattern) {
  if (value === undefined) return {};
  if (!plainObject(value) || Object.keys(value).length > 32) fail(`${label}必须是不超过 32 项的字符串对象。`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key)) fail(`${label}键名无效：${key}。`);
    result[key] = boundedText(item, `${label}.${key}`, { maximum: 4_000 });
  }
  return result;
}

function safeHttpUrl(value, label) {
  const source = boundedText(value, label, { minimum: 1, maximum: 2_000 });
  let parsed;
  try { parsed = new URL(source); }
  catch { fail(`${label}必须是有效 URL。`); }
  const localHttp = parsed.protocol === "http:" && new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) fail(`${label}只能使用 https，或本机回环 http 地址。`);
  if (parsed.username || parsed.password) fail(`${label}不能内嵌用户名或密码。`);
  return parsed.toString();
}

function normalizeSkill(value) {
  const source = assertKnownKeys(value, ["file", "directory"], "Skill 适配器");
  const hasFile = Object.hasOwn(source, "file");
  const hasDirectory = Object.hasOwn(source, "directory");
  if (hasFile === hasDirectory) {
    fail("Skill 适配器必须且只能提供 file 或 directory 其中之一。", "external-manifest-invalid");
  }
  return hasFile
    ? { file: relativePackagePath(source.file, "Skill.file") }
    : { directory: relativePackagePath(source.directory, "Skill.directory") };
}

function normalizeMcp(value) {
  if (!plainObject(value)) fail("MCP 适配器必须是 JSON 对象。", "external-manifest-invalid");
  const transport = boundedText(value.transport, "MCP.transport", { minimum: 1, maximum: 30 }).toLowerCase();
  if (transport === "stdio") {
    const source = assertKnownKeys(value, ["transport", "command", "args", "env"], "stdio MCP 适配器");
    return {
      transport,
      command: mcpCommandToken(source.command, "MCP.command"),
      args: stringList(source.args, "MCP.args").map((item, index) => mcpCommandToken(item, `MCP.args[${index}]`)),
      env: stringMap(source.env, "MCP.env", ENVIRONMENT_KEY),
    };
  }
  if (transport === "http") {
    const source = assertKnownKeys(value, ["transport", "url", "headers"], "HTTP MCP 适配器");
    return {
      transport,
      url: safeHttpUrl(source.url, "MCP.url"),
      headers: stringMap(source.headers, "MCP.headers", HEADER_KEY),
    };
  }
  fail("MCP.transport 目前只支持 stdio 或 http。", "external-manifest-invalid");
}

function normalizeCli(value) {
  const source = assertKnownKeys(value, ["command", "args"], "CLI 适配器");
  return {
    command: boundedText(source.command, "CLI.command", { minimum: 1, maximum: 500 }),
    args: stringList(source.args, "CLI.args"),
  };
}

/** Validates the stable V1 manifest without executing or resolving its code. */
export function validateExternalCapabilityManifest(value) {
  const source = assertKnownKeys(value, ["schemaVersion", "id", "name", "version", "description", "adapters"], "能力清单");
  if (source.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`schemaVersion 必须为 ${MANIFEST_SCHEMA_VERSION}。`, "external-manifest-invalid");
  }
  const adaptersSource = assertKnownKeys(source.adapters, ["skill", "mcp", "cli"], "adapters");
  const adapters = {};
  if (adaptersSource.skill !== undefined) adapters.skill = normalizeSkill(adaptersSource.skill);
  if (adaptersSource.mcp !== undefined) adapters.mcp = normalizeMcp(adaptersSource.mcp);
  if (adaptersSource.cli !== undefined) adapters.cli = normalizeCli(adaptersSource.cli);
  if (!adapters.skill && !adapters.mcp) {
    fail("第一版清单至少需要一个 Skill 或 MCP 适配器；CLI 可同时声明，但暂不能单独登记。", "external-manifest-invalid");
  }
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: capabilityId(source.id),
    name: boundedText(source.name, "能力名称", { minimum: 1, maximum: 120 }),
    version: semanticVersion(source.version),
    description: Object.hasOwn(source, "description")
      ? boundedText(source.description, "能力说明", { maximum: 2_000, allowNewlines: true })
      : "",
    adapters: Object.freeze(adapters),
  });
}

async function lstatIfPresent(fsOps, target) {
  try { return await fsOps.lstat(target); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegularBytes(target, label, { fsOps = fs, maximum = MAX_MANIFEST_BYTES } = {}) {
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat) fail(`${label}不存在。`, "external-source-missing", { path: target });
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件，不能是符号链接。`, "external-source-invalid", { path: target });
  if (stat.size > maximum) fail(`${label}不能超过 ${maximum.toLocaleString("zh-CN")} 字节。`, "external-source-invalid", { path: target });
  const raw = await fsOps.readFile(target);
  const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const afterRead = await lstatIfPresent(fsOps, target);
  if (!afterRead || afterRead.isSymbolicLink() || !afterRead.isFile() || afterRead.size !== content.byteLength || content.byteLength > maximum) {
    fail(`${label}在读取时发生了不安全变更。`, "external-source-invalid", { path: target });
  }
  return content;
}

async function readRegularFile(target, label, options = {}) {
  return (await readRegularBytes(target, label, options)).toString("utf8");
}

/** Reads a chosen local manifest; this does not execute any adapter. */
export async function readExternalCapabilityManifest({ manifestPath, fsOps = fs } = {}) {
  const source = clean(manifestPath);
  if (!source) fail("请先选择 suzu-capability.json 清单文件。", "external-source-missing");
  const resolved = path.resolve(source);
  const raw = await readRegularFile(resolved, "能力清单", { fsOps, maximum: MAX_MANIFEST_BYTES });
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/u, "")); }
  catch { fail("能力清单不是有效 JSON。", "external-manifest-invalid", { path: resolved }); }
  return {
    manifest: validateExternalCapabilityManifest(parsed),
    manifestPath: resolved,
    packageRoot: path.dirname(resolved),
    raw,
  };
}

function dataRoot(value) {
  const root = clean(value);
  if (!root) fail("无法定位 Suzu Lives 软件数据目录。", "external-data-root-missing");
  return path.resolve(root);
}

async function resolveSafeDataRoot(value, fsOps) {
  const root = dataRoot(value);
  let stat = await lstatIfPresent(fsOps, root);
  if (!stat) {
    await fsOps.mkdir(root, { recursive: true });
    stat = await lstatIfPresent(fsOps, root);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("Suzu Lives 软件数据目录不安全或不可写。", "external-data-root-invalid");
  }
  return fsOps.realpath(root);
}

async function ensureSafeDirectory(fsOps, root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!inside(root, current)) fail("外部能力数据路径超出软件数据目录。", "external-data-root-invalid");
    let stat = await lstatIfPresent(fsOps, current);
    if (!stat) {
      await fsOps.mkdir(current);
      stat = await lstatIfPresent(fsOps, current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("外部能力数据目录不安全或不可写。", "external-data-root-invalid", { path: current });
    }
  }
  return current;
}

async function readOptionalSafeFile(fsOps, root, target, label) {
  if (!inside(root, target)) fail("外部能力数据路径无效。", "external-data-root-invalid");
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatIfPresent(fsOps, current);
    if (!stat) return { exists: false, content: "" };
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label}的父目录不安全。`, "external-data-root-invalid");
  }
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat) return { exists: false, content: "" };
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件。`, "external-data-root-invalid");
  return { exists: true, content: await fsOps.readFile(target, "utf8") };
}

async function assertSafeDataFile(fsOps, root, target, label) {
  if (!inside(root, target)) fail("外部能力数据路径无效。", "external-data-root-invalid");
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep).filter(Boolean);
  await ensureSafeDirectory(fsOps, root, segments.slice(0, -1));
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件。`, "external-data-root-invalid");
  return true;
}

async function writeAtomically(fsOps, root, target, content, label) {
  await assertSafeDataFile(fsOps, root, target, label);
  const temporary = `${target}.suzu-lives-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, content, "utf8");
  try {
    await assertSafeDataFile(fsOps, root, target, label);
    await fsOps.rename(temporary, target);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeSafeFile(fsOps, root, target, label) {
  const exists = await assertSafeDataFile(fsOps, root, target, label);
  if (!exists) return;
  await fsOps.unlink(target);
}

function registryPath(root) {
  return path.join(root, "external-capabilities", "registry.json");
}

function persistedManifestPath(root, id) {
  return path.join(root, "external-capabilities", "manifests", id, MANIFEST_FILENAME);
}

function projectKey(projectRoot) {
  const root = path.resolve(clean(projectRoot));
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function registeredAdapterTypes(manifest) {
  return ["skill", "mcp"].filter((type) => manifest.adapters[type]);
}

function normalizeInstallation(value) {
  if (!plainObject(value)) return null;
  const projectRoot = clean(value.projectRoot);
  const types = Array.isArray(value.types) ? value.types.filter((type) => type === "skill" || type === "mcp") : [];
  if (!projectRoot || !types.length) return null;
  return {
    projectRoot: path.resolve(projectRoot),
    types: [...new Set(types)],
    registeredAt: clean(value.registeredAt),
  };
}

function normalizeStoredRecord(id, value, root) {
  if (!plainObject(value)) fail(`外部能力登记 ${id} 格式无效。`, "external-registry-invalid");
  let manifest;
  try { manifest = validateExternalCapabilityManifest(value.manifest); }
  catch (error) {
    fail(`外部能力登记 ${id} 的清单无效：${clean(error?.message) || "未知错误"}`, "external-registry-invalid");
  }
  if (manifest.id !== id) fail(`外部能力登记 ${id} 的 ID 不一致。`, "external-registry-invalid");
  const source = plainObject(value.source) ? value.source : {};
  const manifestPath = clean(source.manifestPath);
  const packageRoot = clean(source.packageRoot);
  const auditPath = clean(source.auditPath) || persistedManifestPath(root, id);
  if (!manifestPath || !packageRoot || !inside(root, path.resolve(auditPath))) {
    fail(`外部能力登记 ${id} 的来源路径无效。`, "external-registry-invalid");
  }
  const installations = {};
  for (const [key, installation] of Object.entries(plainObject(value.installations) ? value.installations : {})) {
    const normalized = normalizeInstallation(installation);
    if (!normalized || key !== projectKey(normalized.projectRoot)) continue;
    installations[key] = normalized;
  }
  return {
    manifest,
    source: {
      manifestPath: path.resolve(manifestPath),
      packageRoot: path.resolve(packageRoot),
      auditPath: path.resolve(auditPath),
    },
    importedAt: clean(value.importedAt),
    updatedAt: clean(value.updatedAt),
    installations,
  };
}

async function readRegistry(root, fsOps) {
  const location = registryPath(root);
  const existing = await readOptionalSafeFile(fsOps, root, location, "外部能力登记");
  if (!existing.exists) return { schemaVersion: REGISTRY_VERSION, capabilities: {} };
  let parsed;
  try { parsed = JSON.parse(existing.content); }
  catch { fail("外部能力登记文件不是有效 JSON。", "external-registry-invalid"); }
  if (!plainObject(parsed) || parsed.schemaVersion !== REGISTRY_VERSION || !plainObject(parsed.capabilities)) {
    fail("外部能力登记文件格式不受支持。", "external-registry-invalid");
  }
  const capabilities = {};
  for (const [id, record] of Object.entries(parsed.capabilities)) {
    if (!CAPABILITY_ID.test(id)) fail("外部能力登记包含无效 ID。", "external-registry-invalid");
    capabilities[id] = normalizeStoredRecord(id, record, root);
  }
  return { schemaVersion: REGISTRY_VERSION, capabilities };
}

async function writeRegistry(root, registry, fsOps) {
  await writeAtomically(fsOps, root, registryPath(root), `${JSON.stringify(registry, null, 2)}\n`, "外部能力登记");
}

function resolvePackageAsset(packageRoot, relativePath) {
  const target = path.resolve(packageRoot, ...relativePath.split("/"));
  if (!inside(packageRoot, target)) fail("能力包文件路径超出清单目录。", "external-source-invalid");
  return target;
}

function skillPackageEntryName(value) {
  const name = String(value ?? "");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\u0000")) {
    fail("Skill 包目录包含无效路径条目。", "external-source-invalid");
  }
  return name;
}

/**
 * Reads a complete Skill package without following links.  Package assets are
 * returned as bytes so references and other non-Markdown resources are copied
 * faithfully; no file is ever executed here.
 */
async function readSkillPackage(directory, { fsOps = fs } = {}) {
  const root = path.resolve(directory);
  const stat = await lstatIfPresent(fsOps, root);
  if (!stat) fail("Skill 包目录不存在。", "external-source-missing", { path: root });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("Skill 包目录必须是真实目录，不能是符号链接。", "external-source-invalid", { path: root });
  }
  const files = [];
  let totalBytes = 0;
  const visit = async (current, segments) => {
    let entries;
    try { entries = await fsOps.readdir(current); }
    catch (error) {
      fail(`无法读取 Skill 包目录：${clean(error?.message) || current}`, "external-source-invalid", { path: current });
    }
    for (const rawName of [...entries].sort((left, right) => String(left).localeCompare(String(right), "en"))) {
      const name = skillPackageEntryName(rawName);
      const target = path.join(current, name);
      if (!inside(root, target)) fail("Skill 包目录路径超出能力包范围。", "external-source-invalid", { path: target });
      const entry = await lstatIfPresent(fsOps, target);
      if (!entry) fail("Skill 包目录在读取时发生了变更。", "external-source-invalid", { path: target });
      if (entry.isSymbolicLink()) fail("Skill 包不能包含符号链接。", "external-source-invalid", { path: target });
      if (entry.isDirectory()) {
        if (segments.length >= MAX_SKILL_PACKAGE_DEPTH) {
          fail(`Skill 包目录层级不能超过 ${MAX_SKILL_PACKAGE_DEPTH} 层。`, "external-source-invalid", { path: target });
        }
        await visit(target, [...segments, name]);
        continue;
      }
      if (!entry.isFile()) fail("Skill 包只能包含普通文件和真实目录。", "external-source-invalid", { path: target });
      if (files.length >= MAX_SKILL_PACKAGE_FILES) {
        fail(`Skill 包文件数不能超过 ${MAX_SKILL_PACKAGE_FILES} 个。`, "external-source-invalid", { path: target });
      }
      const content = await readRegularBytes(target, "Skill 包文件", { fsOps, maximum: MAX_SKILL_BYTES });
      totalBytes += content.byteLength;
      if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
        fail(`Skill 包总大小不能超过 ${MAX_SKILL_PACKAGE_BYTES.toLocaleString("zh-CN")} 字节。`, "external-source-invalid", { path: target });
      }
      const relativePath = [...segments, name].join("/");
      if (relativePath === ".suzu-lives-external-capability.json") {
        fail("Skill 包不能包含 Suzu Lives 保留的受管标记文件。", "external-source-invalid", { path: target });
      }
      files.push({ relativePath, content, sourcePath: target });
    }
  };
  await visit(root, []);
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    fail("Skill 包目录必须在根目录包含 SKILL.md。", "external-source-invalid", { path: root });
  }
  return files;
}

async function readSkillAdapterSource(record, fsOps) {
  const adapter = record.manifest.adapters.skill;
  if (!adapter) return null;
  if (adapter.file) {
    const sourcePath = resolvePackageAsset(record.source.packageRoot, adapter.file);
    return {
      mode: "file",
      sourcePath,
      files: [{
        relativePath: "SKILL.md",
        content: await readRegularBytes(sourcePath, "Skill 源文件", { fsOps, maximum: MAX_SKILL_BYTES }),
        sourcePath,
      }],
    };
  }
  const sourcePath = resolvePackageAsset(record.source.packageRoot, adapter.directory);
  return { mode: "directory", sourcePath, files: await readSkillPackage(sourcePath, { fsOps }) };
}

function isLocalMcpReference(value) {
  return String(value || "").startsWith("./");
}

function mcpLocalReferences(adapter) {
  if (adapter.transport !== "stdio") return [];
  return [adapter.command, ...adapter.args].filter(isLocalMcpReference);
}

async function sourceDiagnostics(record, fsOps) {
  const diagnostics = [];
  try { await readRegularFile(record.source.manifestPath, "原始能力清单", { fsOps, maximum: MAX_MANIFEST_BYTES }); }
  catch (error) {
    diagnostics.push({
      level: "warning",
      code: "manifest-source-missing",
      message: "原始清单已不可读取；Suzu Lives 仍保留导入时的清单副本。",
    });
  }
  if (record.manifest.adapters.skill) {
    try { await readSkillAdapterSource(record, fsOps); }
    catch (error) {
      diagnostics.push({
        level: "error",
        code: error?.code === "external-source-invalid" ? "skill-source-invalid" : "skill-source-missing",
        message: `Skill 源文件或能力包不可用：${clean(error?.message) || "未知错误"}`,
      });
    }
  }
  if (record.manifest.adapters.mcp) {
    for (const reference of mcpLocalReferences(record.manifest.adapters.mcp)) {
      const source = resolvePackageAsset(record.source.packageRoot, reference.slice(2));
      try { await readRegularFile(source, "MCP 本地文件", { fsOps, maximum: MAX_SKILL_BYTES }); }
      catch (error) {
        diagnostics.push({
          level: "error",
          code: "mcp-source-missing",
          message: `MCP 本地文件不可用：${clean(error?.message) || source}`,
        });
      }
    }
  }
  if (record.manifest.adapters.cli) {
    diagnostics.push({
      level: "info",
      code: "cli-reserved",
      message: "已声明 CLI 自动化入口；本期不会执行、探测或写入任意第三方 CLI。",
    });
  }
  return diagnostics;
}

function materializeMcpConfiguration(adapter, packageRoot) {
  const resolveValue = (value) => isLocalMcpReference(value)
    ? resolvePackageAsset(packageRoot, String(value).slice(2))
    : String(value);
  if (adapter.transport === "stdio") {
    return {
      type: "stdio",
      command: resolveValue(adapter.command),
      args: adapter.args.map(resolveValue),
      ...(Object.keys(adapter.env).length ? { env: { ...adapter.env } } : {}),
    };
  }
  return {
    type: "http",
    url: adapter.url,
    ...(Object.keys(adapter.headers).length ? { headers: { ...adapter.headers } } : {}),
  };
}

async function resolveRegistrationSources(record, fsOps) {
  const diagnostics = await sourceDiagnostics(record, fsOps);
  const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (errors.length) {
    const code = errors.some((diagnostic) => diagnostic.code === "skill-source-invalid")
      ? "external-source-invalid"
      : "external-source-missing";
    fail(errors.map((diagnostic) => diagnostic.message).join("；"), code, { diagnostics: errors });
  }
  const skill = record.manifest.adapters.skill ? await readSkillAdapterSource(record, fsOps) : null;
  const mcp = record.manifest.adapters.mcp
    ? { configuration: materializeMcpConfiguration(record.manifest.adapters.mcp, record.source.packageRoot) }
    : null;
  return { skill, mcp };
}

function diagnosticStatus({ diagnostics, registration, manifest }) {
  if (diagnostics.some((item) => item.level === "error")) return "error";
  const types = registeredAdapterTypes(manifest);
  if (types.every((type) => registration[type]?.registered === true)) return "registered";
  if (types.some((type) => registration[type]?.registered === true)) return "partial";
  return "ready";
}

function requiredRegistrationAdapter(value) {
  const adapter = value;
  for (const method of ["inspect", "remove", "write"]) {
    if (typeof adapter?.[method] !== "function") {
      fail(`外部能力登记适配器缺少 ${method}()。`, "external-registration-adapter-invalid");
    }
  }
  return adapter;
}

async function snapshotRecord(record, { projectRoot, fsOps, registrationAdapter, scopeLabel }) {
  const types = registeredAdapterTypes(record.manifest);
  const diagnostics = await sourceDiagnostics(record, fsOps);
  let inspected;
  try {
    inspected = await registrationAdapter.inspect({ projectRoot, capabilityId: record.manifest.id, types, fsOps });
  } catch (error) {
    inspected = { registered: false };
    for (const type of types) inspected[type] = { registered: false, reason: clean(error?.message) || "无法读取当前项目登记状态。", version: "" };
  }
  const registration = Object.fromEntries(types.map((type) => [type, inspected[type] || { registered: false, reason: "未登记。", version: "" }]));
  for (const type of types) {
    const current = registration[type];
    if (current.registered && current.version && current.version !== record.manifest.version) {
      diagnostics.push({
        level: "warning",
        code: "registration-update-available",
        message: `${type === "skill" ? "Skill" : "MCP"} 当前登记的是 ${current.version}；再次启用可更新到 ${record.manifest.version}。`,
      });
    }
    if (clean(projectRoot) && !current.registered && current.reason && !/没有这项|尚未选择/u.test(current.reason)) {
      diagnostics.push({ level: "warning", code: `registration-${type}-attention`, message: current.reason });
    }
  }
  if (!clean(projectRoot)) {
    diagnostics.push({ level: "info", code: "project-missing", message: `先选择${scopeLabel}，才能启用或停用外部能力。` });
  }
  const key = clean(projectRoot) ? projectKey(projectRoot) : "";
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    types: Object.keys(record.manifest.adapters),
    registrationTypes: types,
    source: { ...record.source },
    importedAt: record.importedAt,
    updatedAt: record.updatedAt,
    registration,
    enabled: types.every((type) => registration[type]?.registered === true),
    status: diagnosticStatus({ diagnostics, registration, manifest: record.manifest }),
    diagnostics,
    canEnable: Boolean(clean(projectRoot)) && !diagnostics.some((item) => item.level === "error"),
    canDisable: Boolean(clean(projectRoot)) && (types.some((type) => registration[type]?.registered === true) || Boolean(record.installations[key])),
  };
}

function normalizedProjectRoot(value, scopeLabel) {
  const source = clean(value);
  if (!source) fail(`请先选择${scopeLabel}。`, "external-project-missing");
  return path.resolve(source);
}

function installationKeysForRoots(value) {
  const keys = new Set();
  for (const candidate of Array.isArray(value) ? value : []) {
    const root = clean(candidate);
    if (!root || !path.isAbsolute(root)) continue;
    keys.add(projectKey(root));
  }
  return keys;
}

/**
 * Creates the external-capability control plane. It imports only local JSON
 * selected by the user and deliberately has no execution or download method.
 */
export function createExternalCapabilitiesService({
  dataRoot: configuredDataRoot,
  projectRoot = "",
  fsOps = fs,
  now = () => new Date(),
  registrationAdapter = null,
  scopeLabel = "当前能力运行时范围",
} = {}) {
  const adapter = requiredRegistrationAdapter(registrationAdapter);
  const registrationScopeLabel = clean(scopeLabel) || "当前能力运行时范围";
  const rootPromise = resolveSafeDataRoot(configuredDataRoot, fsOps);
  const withRoot = async (action) => action(await rootPromise);
  const currentProject = () => normalizedProjectRoot(projectRoot, registrationScopeLabel);
  const getRecord = async (id) => withRoot(async (root) => {
    const registry = await readRegistry(root, fsOps);
    const record = registry.capabilities[capabilityId(id)];
    if (!record) fail("没有找到这项已导入的外部能力。", "external-capability-not-found");
    return { root, registry, record };
  });

  return {
    async snapshot() {
      return withRoot(async (root) => {
        const registry = await readRegistry(root, fsOps);
        const current = clean(projectRoot) ? path.resolve(projectRoot) : "";
        const capabilities = await Promise.all(Object.values(registry.capabilities)
          .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, "zh-CN"))
          .map((record) => snapshotRecord(record, {
            projectRoot: current,
            fsOps,
            registrationAdapter: adapter,
            scopeLabel: registrationScopeLabel,
          })));
        return { projectRoot: current, capabilities };
      });
    },

    async importManifest({ manifestPath } = {}) {
      const selected = await readExternalCapabilityManifest({ manifestPath, fsOps });
      return withRoot(async (root) => {
        const registry = await readRegistry(root, fsOps);
        const existing = registry.capabilities[selected.manifest.id];
        const nextTypes = registeredAdapterTypes(selected.manifest).sort().join(",");
        const existingTypes = existing ? registeredAdapterTypes(existing.manifest).sort().join(",") : "";
        if (existing && Object.keys(existing.installations).length && nextTypes !== existingTypes) {
          fail("这项能力已登记到项目；请先在所有已登记联系人中停用，再改变 Skill/MCP 适配器类型。", "external-update-in-use");
        }
        const timestamp = now().toISOString();
        const auditPath = persistedManifestPath(root, selected.manifest.id);
        const record = {
          manifest: selected.manifest,
          source: {
            manifestPath: selected.manifestPath,
            packageRoot: selected.packageRoot,
            auditPath,
          },
          importedAt: existing?.importedAt || timestamp,
          updatedAt: timestamp,
          installations: existing?.installations || {},
        };
        registry.capabilities[selected.manifest.id] = record;
        const previousAudit = await readOptionalSafeFile(fsOps, root, auditPath, "已保存的能力清单");
        await writeAtomically(fsOps, root, auditPath, selected.raw, "已保存的能力清单");
        try { await writeRegistry(root, registry, fsOps); }
        catch (error) {
          if (previousAudit.exists) await writeAtomically(fsOps, root, auditPath, previousAudit.content, "已保存的能力清单").catch(() => undefined);
          else await removeSafeFile(fsOps, root, auditPath, "已保存的能力清单").catch(() => undefined);
          throw error;
        }
        const snapshot = await this.snapshot();
        return { created: !existing, updated: Boolean(existing), capability: snapshot.capabilities.find((item) => item.id === selected.manifest.id), snapshot };
      });
    },

    async setEnabled({ id, enabled } = {}) {
      if (typeof enabled !== "boolean") fail("外部能力开关状态无效。", "external-request-invalid");
      const project = currentProject();
      const { root, registry, record } = await getRecord(id);
      const key = projectKey(project);
      const types = record.installations[key]?.types || registeredAdapterTypes(record.manifest);
      if (!enabled) {
        const result = await adapter.remove({ projectRoot: project, capabilityId: record.manifest.id, types, fsOps });
        delete record.installations[key];
        await writeRegistry(root, registry, fsOps);
        return { enabled: false, registration: result, snapshot: await this.snapshot() };
      }
      const sources = await resolveRegistrationSources(record, fsOps);
      const registration = await adapter.write({
        projectRoot: project,
        capabilityId: record.manifest.id,
        version: record.manifest.version,
        skill: sources.skill,
        mcp: sources.mcp,
        fsOps,
      });
      record.installations[key] = {
        projectRoot: project,
        types: registeredAdapterTypes(record.manifest),
        registeredAt: now().toISOString(),
      };
      try { await writeRegistry(root, registry, fsOps); }
      catch (error) {
        await adapter.remove({ projectRoot: project, capabilityId: record.manifest.id, types: registeredAdapterTypes(record.manifest), fsOps }).catch(() => undefined);
        throw error;
      }
      return { enabled: true, registration, snapshot: await this.snapshot() };
    },

    /**
     * Re-homes installations that were materialized by a retired host.  The
     * generic registry remains the authority: the new adapter is written and
     * inspected before the old installation rows are removed.  Callers may
     * clean the retired host projection only after this method succeeds.
     */
    async adoptInstallations({ legacyProjectRoots = [] } = {}) {
      const destination = currentProject();
      const destinationKey = projectKey(destination);
      const legacyKeys = installationKeysForRoots(legacyProjectRoots);
      legacyKeys.delete(destinationKey);
      if (!legacyKeys.size) {
        return { adopted: true, migratedCapabilities: 0, capabilityIds: [], registrations: [] };
      }
      return withRoot(async (root) => {
        const registry = await readRegistry(root, fsOps);
        const registrations = [];
        for (const record of Object.values(registry.capabilities)) {
          const sourceKeys = Object.keys(record.installations).filter((key) => legacyKeys.has(key));
          if (!sourceKeys.length) continue;
          // The old registry records which host adapters were actually
          // enabled.  A capability package can declare both Skill and MCP, but
          // adoption must not turn on an adapter a user had disabled.  Include
          // a pre-existing managed installation as well, so adoption never
          // narrows an already configured capability.
          const enabledTypes = new Set([
            ...sourceKeys.flatMap((key) => record.installations[key]?.types || []),
            ...(record.installations[destinationKey]?.types || []),
          ]);
          const types = registeredAdapterTypes(record.manifest).filter((type) => enabledTypes.has(type));
          if (!types.length) {
            fail(`旧版外部能力 ${record.manifest.id} 没有可接管的有效登记类型。`, "external-adoption-invalid");
          }
          const sources = await resolveRegistrationSources(record, fsOps);
          const registration = await adapter.write({
            projectRoot: destination,
            capabilityId: record.manifest.id,
            version: record.manifest.version,
            skill: types.includes("skill") ? sources.skill : null,
            mcp: types.includes("mcp") ? sources.mcp : null,
            fsOps,
          });
          const inspected = await adapter.inspect({
            projectRoot: destination,
            capabilityId: record.manifest.id,
            types,
            fsOps,
          });
          if (!types.every((type) => inspected?.[type]?.registered === true)) {
            fail(`新版运行时没有确认接管外部能力 ${record.manifest.id}。`, "external-adoption-unverified");
          }
          const registeredAt = record.installations[destinationKey]?.registeredAt
            || record.installations[sourceKeys[0]]?.registeredAt
            || now().toISOString();
          const sourceProjectRoots = sourceKeys.map((key) => record.installations[key]?.projectRoot || key);
          record.installations[destinationKey] = {
            projectRoot: destination,
            types,
            registeredAt,
          };
          for (const key of sourceKeys) delete record.installations[key];
          registrations.push({
            id: record.manifest.id,
            types: [...types],
            sourceProjectRoots,
            registration,
          });
        }
        if (registrations.length) await writeRegistry(root, registry, fsOps);
        return {
          adopted: true,
          migratedCapabilities: registrations.length,
          capabilityIds: registrations.map((entry) => entry.id).sort((left, right) => left.localeCompare(right, "en")),
          registrations,
        };
      });
    },

    async remove({ id, confirmed = false } = {}) {
      if (confirmed !== true) fail("移除外部能力前需要明确确认。", "external-remove-confirmation-required");
      const { root, registry, record } = await getRecord(id);
      for (const installation of Object.values(record.installations)) {
        await adapter.remove({
          projectRoot: installation.projectRoot,
          capabilityId: record.manifest.id,
          types: installation.types,
          fsOps,
        });
      }
      delete registry.capabilities[record.manifest.id];
      await writeRegistry(root, registry, fsOps);
      await removeSafeFile(fsOps, root, record.source.auditPath, "已保存的能力清单");
      return { removed: true, snapshot: await this.snapshot() };
    },
  };
}
