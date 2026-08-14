import fs from "node:fs/promises";
import path from "node:path";

export class RelationshipFilesError extends Error {}

const STANDARD_FILES = new Set(["CLAUDE.md", "persona.md", "user.md"]);
const EXCLUDED_FILE = "abilities.md";
const MAX_TEXT_LENGTH = 1_000_000;

function clean(value) { return String(value ?? "").trim(); }
function isStandardFile(value) { return [...STANDARD_FILES].some((file) => file.toLowerCase() === String(value).toLowerCase()); }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

export function normalizeRelationshipPath(value, { allowStandard = true } = {}) {
  const raw = clean(value).replaceAll("\\", "/");
  if (!raw || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.includes(":")) throw new RelationshipFilesError("Markdown 文件路径必须是项目内的相对路径。 ");
  const segments = raw.split("/");
  if (segments.some((part) => !part || part === "." || part === "..") || !raw.toLowerCase().endsWith(".md")) throw new RelationshipFilesError("只允许安全的相对 .md 文件路径。 ");
  if (segments[0].toLowerCase() === ".claude" || raw.toLowerCase() === EXCLUDED_FILE) throw new RelationshipFilesError("abilities.md 与 .claude 目录由能力页面管理。 ");
  const normalized = segments.join("/"); const standard = [...STANDARD_FILES].find((file) => file.toLowerCase() === normalized.toLowerCase());
  if (!allowStandard && standard) throw new RelationshipFilesError("请直接编辑已有的标准关系文件。 ");
  if (raw.length > 240) throw new RelationshipFilesError("Markdown 文件路径过长。 ");
  return standard || normalized;
}

async function projectRoot(projectRoot, fsOps) {
  const requested = clean(projectRoot); if (!requested) throw new RelationshipFilesError("请先选择 Claude 项目目录。 ");
  const target = path.resolve(requested); let stat;
  try { stat = await fsOps.lstat(target); } catch { throw new RelationshipFilesError("选择的 Claude 项目目录不存在。 "); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RelationshipFilesError("选择的 Claude 项目目录必须是安全的普通目录。 ");
  return fsOps.realpath(target);
}

async function safeTarget(root, relativePath, fsOps, { createParents = false } = {}) {
  const relative = normalizeRelationshipPath(relativePath); const target = path.resolve(root, ...relative.split("/"));
  if (!inside(root, target)) throw new RelationshipFilesError("关系文件路径超出当前项目目录。 ");
  const segments = path.relative(root, target).split(path.sep).filter(Boolean); let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment); let stat;
    try { stat = await fsOps.lstat(current); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!createParents) return { target, exists: false };
      await fsOps.mkdir(current); stat = await fsOps.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RelationshipFilesError("关系文件父目录必须位于项目内且不能是符号链接。 ");
  }
  let stat; try { stat = await fsOps.lstat(target); } catch (error) { if (error?.code === "ENOENT") return { target, exists: false }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RelationshipFilesError("关系文件必须是项目内的普通文件，不能是符号链接。 ");
  return { target, exists: true };
}

async function readText(root, relativePath, fsOps) {
  const checked = await safeTarget(root, relativePath, fsOps); if (!checked.exists) return { path: relativePath, exists: false, content: "" };
  const content = await fsOps.readFile(checked.target, "utf8"); await safeTarget(root, relativePath, fsOps); return { path: relativePath, exists: true, content };
}

async function writeAtomic(root, relativePath, content, fsOps, { requireMissing = false } = {}) {
  if (typeof content !== "string" || content.length > MAX_TEXT_LENGTH) throw new RelationshipFilesError("关系文本必须是少于 1 MB 的普通文本。 ");
  const checked = await safeTarget(root, relativePath, fsOps, { createParents: true });
  if (requireMissing && checked.exists) throw new RelationshipFilesError("目标 Markdown 文件已存在，不能静默覆盖。 ");
  const temporary = `${checked.target}.suzu-lives-${process.pid}-${Date.now()}.tmp`;
  await fsOps.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try { await safeTarget(root, relativePath, fsOps); await fsOps.rename(temporary, checked.target); }
  catch (error) { await fsOps.unlink(temporary).catch(() => undefined); throw error; }
}

async function deleteIfPresent(root, relativePath, fsOps) {
  const checked = await safeTarget(root, relativePath, fsOps);
  if (!checked.exists) return;
  await fsOps.unlink(checked.target);
}

async function writeRelationshipTransaction(root, files, fsOps) {
  const prepared = [];
  try {
    for (const file of files) {
      if (typeof file.content !== "string" || file.content.length > MAX_TEXT_LENGTH) throw new RelationshipFilesError("关系文本必须是少于 1 MB 的普通文本。 ");
      const checked = await safeTarget(root, file.path, fsOps, { createParents: true });
      if (file.requireMissing && checked.exists) throw new RelationshipFilesError("目标 Markdown 文件已存在，不能静默覆盖。 ");
      const previous = checked.exists ? { exists: true, content: await fsOps.readFile(checked.target, "utf8") } : { exists: false, content: "" };
      await safeTarget(root, file.path, fsOps);
      const temporary = `${checked.target}.suzu-lives-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      await fsOps.writeFile(temporary, file.content, { encoding: "utf8", flag: "wx" });
      prepared.push({ ...file, previous, temporary });
    }
  } catch (error) {
    await Promise.all(prepared.map((file) => fsOps.unlink(file.temporary).catch(() => undefined)));
    throw error;
  }

  const committed = [];
  try {
    for (const file of prepared) {
      const checked = await safeTarget(root, file.path, fsOps);
      await fsOps.rename(file.temporary, checked.target);
      committed.push(file);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const file of committed.reverse()) {
      try {
        if (file.previous.exists) await writeAtomic(root, file.path, file.previous.content, fsOps);
        else await deleteIfPresent(root, file.path, fsOps);
      } catch (rollbackError) { rollbackErrors.push(clean(rollbackError?.message) || "unknown rollback error"); }
    }
    await Promise.all(prepared.filter((file) => !committed.includes(file)).map((file) => fsOps.unlink(file.temporary).catch(() => undefined)));
    const detail = clean(error?.message) ? ` 原因：${clean(error.message)}` : "";
    const rollback = rollbackErrors.length ? `；回滚失败：${rollbackErrors.join("；")}` : "；已回滚此前写入";
    throw new RelationshipFilesError(`关系文件写入未完成${rollback}。${detail}`);
  }
}

function managedClaudeReference(value) {
  const raw = clean(value).replaceAll("\\", "/");
  if (raw.toLowerCase() === EXCLUDED_FILE) return EXCLUDED_FILE;
  try {
    const normalized = normalizeRelationshipPath(raw);
    return normalized.toLowerCase() === "claude.md" ? "" : normalized;
  } catch {
    return "";
  }
}

function managedClaudeReferenceLine(line) {
  const value = String(line ?? "").trim();
  return value.startsWith("@") ? managedClaudeReference(value.slice(1)) : "";
}

function markdownReferenceLine(line) {
  return /^@.+\.md$/iu.test(String(line ?? "").trim());
}

function managedClaudeReferences(content) {
  const references = [];
  const seen = new Set();
  for (const line of String(content ?? "").split(/\r?\n/u)) {
    const reference = managedClaudeReferenceLine(line);
    const key = reference.toLowerCase();
    if (!reference || seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function visibleClaudeContent(content) {
  const source = String(content ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return source.split(/\r?\n/u).filter((line) => !markdownReferenceLine(line)).join(eol);
}

function restoreClaudeReferences(content, existingClaude) {
  const references = managedClaudeReferences(existingClaude);
  const next = visibleClaudeContent(content);
  if (!references.length) return next;
  const eol = next.includes("\r\n") || (!next.includes("\n") && String(existingClaude ?? "").includes("\r\n")) ? "\r\n" : "\n";
  const suffix = references.map((reference) => `@${reference}`).join(eol);
  if (!next) return suffix;
  return next.endsWith("\n") ? `${next}${suffix}` : `${next}${eol}${suffix}`;
}

export function ensureUniqueClaudeReference(content, relativePath) {
  const reference = managedClaudeReference(relativePath); if (!reference) return String(content ?? ""); const eol = content.includes("\r\n") ? "\r\n" : "\n"; const lines = String(content ?? "").split(/\r?\n/u); const expected = `@${reference}`; let kept = false;
  const next = lines.filter((line) => { if (line.trim() !== expected) return true; if (kept) return false; kept = true; return true; });
  if (!kept) { if (next.length === 1 && next[0] === "") next.length = 0; next.push(expected); }
  return next.join(eol);
}

function referencedFiles(claudeContent) {
  const result = new Set();
  for (const line of String(claudeContent || "").split(/\r?\n/u)) {
    const value = line.trim(); if (!value.startsWith("@")) continue;
    try { const relative = normalizeRelationshipPath(value.slice(1)); if (relative.toLowerCase() !== EXCLUDED_FILE && !isStandardFile(relative)) result.add(relative); } catch {}
  }
  return [...result];
}

export function createRelationshipFilesService({ settingsService, fsOps = fs } = {}) {
  if (!settingsService?.load) throw new RelationshipFilesError("关系文件服务需要设置服务。 ");
  const root = () => projectRoot(settingsService.load()?.projectRoot, fsOps);
  const snapshot = async () => {
    const configured = clean(settingsService.load()?.projectRoot); if (!configured) return { status: "needs-project", files: [] };
    const selectedRoot = await root(); const claude = await readText(selectedRoot, "CLAUDE.md", fsOps); const requested = [...STANDARD_FILES, ...referencedFiles(claude.content)].filter((item, index, all) => all.indexOf(item) === index && item !== EXCLUDED_FILE);
    const visibleClaude = { ...claude, content: visibleClaudeContent(claude.content) };
    const files = [];
    for (const relativePath of requested) { const file = relativePath === "CLAUDE.md" ? visibleClaude : await readText(selectedRoot, relativePath, fsOps); files.push({ ...file, kind: isStandardFile(relativePath) ? "standard" : "custom" }); }
    return { status: "ready", files };
  };
  const save = async ({ path: relativePath, content } = {}) => {
    const selectedRoot = await root(); const normalized = normalizeRelationshipPath(relativePath);
    if (normalized === "CLAUDE.md") { const claude = await readText(selectedRoot, normalized, fsOps); await writeAtomic(selectedRoot, normalized, restoreClaudeReferences(content, claude.content), fsOps); return snapshot(); }
    const claude = await readText(selectedRoot, "CLAUDE.md", fsOps);
    if (!isStandardFile(normalized) && !referencedFiles(claude.content).includes(normalized)) throw new RelationshipFilesError("只能编辑当前相处设定页已引用的自定义 Markdown 文件。 ");
    const nextClaude = ensureUniqueClaudeReference(claude.content, normalized);
    await writeRelationshipTransaction(selectedRoot, [
      { path: normalized, content },
      { path: "CLAUDE.md", content: nextClaude },
    ], fsOps);
    return snapshot();
  };
  const create = async ({ path: relativePath, content = "" } = {}) => {
    const selectedRoot = await root(); const normalized = normalizeRelationshipPath(relativePath, { allowStandard: false }); const claude = await readText(selectedRoot, "CLAUDE.md", fsOps); const nextClaude = ensureUniqueClaudeReference(claude.content, normalized);
    await writeRelationshipTransaction(selectedRoot, [
      { path: normalized, content, requireMissing: true },
      { path: "CLAUDE.md", content: nextClaude },
    ], fsOps);
    return snapshot();
  };
  return { snapshot, save, create };
}

export function registerRelationshipFilesIpc({ ipcMain, relationshipFilesService }) {
  ipcMain.handle("relationship-files:snapshot", () => relationshipFilesService.snapshot());
  ipcMain.handle("relationship-files:save", (_event, value) => relationshipFilesService.save(value));
  ipcMain.handle("relationship-files:create", (_event, value) => relationshipFilesService.create(value));
}
