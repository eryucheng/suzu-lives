import fs from "node:fs/promises";
import path from "node:path";

export class RelationshipFilesError extends Error {}

const PRIMARY_FILE = "SUZU.md";
const STANDARD_FILES = new Set([PRIMARY_FILE, "persona.md", "user.md"]);
const EXCLUDED_FILE = "abilities.md";
const MAX_TEXT_LENGTH = 1_000_000;
// SUZU.md 里的自动展开区：保存相处资料时把 @ 引用的文件内容拼进这个区域，
// 让 agent 读取 SUZU.md 全文时能看到所有资料（Agent Core 指令加载器不解析 @ 引用）。
const RELATIONSHIP_SECTION_OPEN = "<!-- suzu-lives:relationship-files -->";
const RELATIONSHIP_SECTION_CLOSE = "<!-- /suzu-lives:relationship-files -->";
const MAX_EXPANDED_BYTES = 24_000;
const MAX_EXPANDED_FILE_CHARS = 4_000;

function clean(value) { return String(value ?? "").trim(); }
function isStandardFile(value) { return [...STANDARD_FILES].some((file) => file.toLowerCase() === String(value).toLowerCase()); }
function isPrimaryFile(value) { return PRIMARY_FILE.toLowerCase() === String(value).toLowerCase(); }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }

export function normalizeRelationshipPath(value, { allowStandard = true } = {}) {
  const raw = clean(value).replaceAll("\\", "/");
  if (!raw || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.includes(":")) throw new RelationshipFilesError("Markdown 文件路径必须是联系人工作区内的相对路径。 ");
  const segments = raw.split("/");
  if (segments.some((part) => !part || part === "." || part === "..") || !raw.toLowerCase().endsWith(".md")) throw new RelationshipFilesError("只允许安全的相对 .md 文件路径。 ");
  if (segments[0].toLowerCase() === ".suzu-lives" || raw.toLowerCase() === EXCLUDED_FILE) throw new RelationshipFilesError("abilities.md 与内部资料目录由软件管理。 ");
  const normalized = segments.join("/");
  const standard = [...STANDARD_FILES].find((file) => file.toLowerCase() === normalized.toLowerCase());
  if (!allowStandard && standard) throw new RelationshipFilesError("请直接编辑已有的标准相处资料。 ");
  if (raw.length > 240) throw new RelationshipFilesError("Markdown 文件路径过长。 ");
  return standard || normalized;
}

async function projectRoot(projectRoot, fsOps) {
  const requested = clean(projectRoot); if (!requested) throw new RelationshipFilesError("请先选择联系人工作区。 ");
  const target = path.resolve(requested); let stat;
  try { stat = await fsOps.lstat(target); } catch { throw new RelationshipFilesError("选择的联系人工作区不存在。 "); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RelationshipFilesError("联系人工作区必须是安全的普通目录。 ");
  return fsOps.realpath(target);
}

async function safeTarget(root, relativePath, fsOps, { createParents = false } = {}) {
  const relative = normalizeRelationshipPath(relativePath); const target = path.resolve(root, ...relative.split("/"));
  if (!inside(root, target)) throw new RelationshipFilesError("关系文件路径超出当前联系人工作区。 ");
  const segments = path.relative(root, target).split(path.sep).filter(Boolean); let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment); let stat;
    try { stat = await fsOps.lstat(current); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!createParents) return { target, exists: false };
      await fsOps.mkdir(current); stat = await fsOps.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RelationshipFilesError("关系文件父目录必须位于联系人工作区内且不能是符号链接。 ");
  }
  let stat; try { stat = await fsOps.lstat(target); } catch (error) { if (error?.code === "ENOENT") return { target, exists: false }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new RelationshipFilesError("关系文件必须是联系人工作区内的普通文件，不能是符号链接。 ");
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

function managedSuzuReference(value) {
  const raw = clean(value).replaceAll("\\", "/");
  if (raw.toLowerCase() === EXCLUDED_FILE) return EXCLUDED_FILE;
  try {
    const normalized = normalizeRelationshipPath(raw);
    return isPrimaryFile(normalized) ? "" : normalized;
  } catch {
    return "";
  }
}

function managedSuzuReferenceLine(line) {
  const value = String(line ?? "").trim();
  return value.startsWith("@") ? managedSuzuReference(value.slice(1)) : "";
}

function markdownReferenceLine(line) {
  return /^@.+\.md$/iu.test(String(line ?? "").trim());
}

function managedSuzuReferences(content) {
  const references = [];
  const seen = new Set();
  for (const line of String(content ?? "").split(/\r?\n/u)) {
    const reference = managedSuzuReferenceLine(line);
    const key = reference.toLowerCase();
    if (!reference || seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function visibleSuzuContent(content) {
  const source = String(content ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return source.split(/\r?\n/u).filter((line) => !markdownReferenceLine(line)).join(eol);
}

function withoutRelationshipSection(content) {
  const source = String(content ?? "");
  const open = source.indexOf(RELATIONSHIP_SECTION_OPEN);
  if (open < 0) return source;
  const close = source.indexOf(RELATIONSHIP_SECTION_CLOSE, open + RELATIONSHIP_SECTION_OPEN.length);
  if (close < 0) return source;
  return `${source.slice(0, open)}${source.slice(close + RELATIONSHIP_SECTION_CLOSE.length)}`;
}

function expandedReferenceHeading(reference) {
  const name = reference.toLowerCase();
  if (name === "user.md") {
    return "用户本人的核心档案（user.md）—— 以下内容描述用户本人，不是 Agent 的属性或人设";
  }
  if (name === "persona.md") {
    return "Agent 人设（persona.md）—— 以下内容描述 Agent 自己";
  }
  return `相处资料（${reference}）`;
}

async function expandSuzuReferences(root, suzuContent, fsOps) {
  const source = String(suzuContent ?? "");
  const references = managedSuzuReferences(source);
  if (!references.length) return source;
  const sections = [];
  let total = 0;
  for (const reference of references) {
    if (reference.toLowerCase() === EXCLUDED_FILE) continue;
    const checked = await safeTarget(root, reference, fsOps);
    if (!checked.exists) {
      sections.push(`## ${expandedReferenceHeading(reference)}\n\n（文件不存在）`);
      continue;
    }
    let text;
    try {
      text = await fsOps.readFile(checked.target, "utf8");
    } catch {
      sections.push(`## ${expandedReferenceHeading(reference)}\n\n（无法读取）`);
      continue;
    }
    const limited = text.length > MAX_EXPANDED_FILE_CHARS ? `${text.slice(0, MAX_EXPANDED_FILE_CHARS)}\n[内容已截断]` : text;
    total += limited.length;
    if (total > MAX_EXPANDED_BYTES) {
      sections.push(`## ${expandedReferenceHeading(reference)}\n\n（资料过多，已省略）`);
      break;
    }
    sections.push(`## ${expandedReferenceHeading(reference)}\n\n${limited}`);
  }
  const expanded = [
    RELATIONSHIP_SECTION_OPEN,
    ...sections,
    RELATIONSHIP_SECTION_CLOSE,
  ].join("\n");
  const base = withoutRelationshipSection(source).trimEnd();
  return base ? `${base}\n\n${expanded}\n` : `${expanded}\n`;
}

/**
 * Builds the exact on-disk SUZU.md form consumed by the Agent Core instruction
 * bridge.  Kept public so one-off importers do not reproduce the reference
 * expansion rules (or accidentally leave an invisible stale expansion
 * section behind).
 */
export async function materializeSuzuInstructions({ projectRoot: selectedProjectRoot, content, fsOps = fs } = {}) {
  if (typeof content !== "string" || content.length > MAX_TEXT_LENGTH) {
    throw new RelationshipFilesError("关系文本必须是少于 1 MB 的普通文本。 ");
  }
  const root = await projectRoot(selectedProjectRoot, fsOps);
  return expandSuzuReferences(root, content, fsOps);
}

function restoreSuzuReferences(content, existingSuzu) {
  const references = managedSuzuReferences(existingSuzu);
  const next = visibleSuzuContent(content);
  if (!references.length) return next;
  const eol = next.includes("\r\n") || (!next.includes("\n") && String(existingSuzu ?? "").includes("\r\n")) ? "\r\n" : "\n";
  const suffix = references.map((reference) => `@${reference}`).join(eol);
  if (!next) return suffix;
  return next.endsWith("\n") ? `${next}${suffix}` : `${next}${eol}${suffix}`;
}

export function ensureUniqueSuzuReference(content, relativePath) {
  const reference = managedSuzuReference(relativePath); if (!reference) return String(content ?? ""); const eol = content.includes("\r\n") ? "\r\n" : "\n"; const lines = String(content ?? "").split(/\r?\n/u); const expected = `@${reference}`; let kept = false;
  const next = lines.filter((line) => { if (line.trim() !== expected) return true; if (kept) return false; kept = true; return true; });
  if (!kept) { if (next.length === 1 && next[0] === "") next.length = 0; next.push(expected); }
  return next.join(eol);
}

function referencedFiles(suzuContent) {
  const result = new Set();
  for (const line of String(suzuContent || "").split(/\r?\n/u)) {
    const value = line.trim(); if (!value.startsWith("@")) continue;
    try {
      const relative = normalizeRelationshipPath(value.slice(1));
      if (relative.toLowerCase() !== EXCLUDED_FILE && !isStandardFile(relative)) result.add(relative);
    } catch {}
  }
  return [...result];
}

export function createRelationshipFilesService({ settingsService, fsOps = fs } = {}) {
  if (!settingsService?.load) throw new RelationshipFilesError("关系文件服务需要设置服务。 ");
  const root = () => projectRoot(settingsService.load()?.projectRoot, fsOps);
  const snapshot = async () => {
    const configured = clean(settingsService.load()?.projectRoot); if (!configured) return { status: "needs-project", files: [] };
    const selectedRoot = await root();
    const suzu = await readText(selectedRoot, PRIMARY_FILE, fsOps);
    const requested = [...STANDARD_FILES, ...referencedFiles(suzu.content)].filter((item, index, all) => all.indexOf(item) === index && item !== EXCLUDED_FILE);
    const visibleSuzu = { ...suzu, content: visibleSuzuContent(withoutRelationshipSection(suzu.content)) };
    const files = [];
    for (const relativePath of requested) {
      const file = isPrimaryFile(relativePath) ? visibleSuzu : await readText(selectedRoot, relativePath, fsOps);
      files.push({ ...file, kind: isStandardFile(relativePath) ? "standard" : "custom", readOnly: false });
    }
    return {
      status: "ready",
      files,
    };
  };
  const save = async ({ path: relativePath, content } = {}) => {
    const selectedRoot = await root(); const normalized = normalizeRelationshipPath(relativePath);
    if (isPrimaryFile(normalized)) {
      const suzu = await readText(selectedRoot, PRIMARY_FILE, fsOps);
      const restored = restoreSuzuReferences(content, suzu.content);
      await writeAtomic(selectedRoot, PRIMARY_FILE, await expandSuzuReferences(selectedRoot, restored, fsOps), fsOps);
      return snapshot();
    }
    const suzu = await readText(selectedRoot, PRIMARY_FILE, fsOps);
    if (!isStandardFile(normalized) && !referencedFiles(suzu.content).includes(normalized)) throw new RelationshipFilesError("只能编辑当前相处设定页已引用的自定义 Markdown 文件。 ");
    const nextSuzu = await expandSuzuReferences(selectedRoot, ensureUniqueSuzuReference(suzu.content, normalized), fsOps);
    await writeRelationshipTransaction(selectedRoot, [
      { path: normalized, content },
      { path: PRIMARY_FILE, content: nextSuzu },
    ], fsOps);
    return snapshot();
  };
  const create = async ({ path: relativePath, content = "" } = {}) => {
    const selectedRoot = await root(); const normalized = normalizeRelationshipPath(relativePath, { allowStandard: false });
    const suzu = await readText(selectedRoot, PRIMARY_FILE, fsOps);
    const nextSuzu = await expandSuzuReferences(selectedRoot, ensureUniqueSuzuReference(suzu.content, normalized), fsOps);
    await writeRelationshipTransaction(selectedRoot, [
      { path: normalized, content, requireMissing: true },
      { path: PRIMARY_FILE, content: nextSuzu },
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
