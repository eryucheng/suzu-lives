import fs from "node:fs/promises";
import path from "node:path";

const MAIL_BRIDGE_CONFIG_PATH = Object.freeze(["automation", "mail-bridge", "config.json"]);
const LEGACY_MAIL_SKILL_ID = "rule-legacy";
const MAX_MAIL_SKILL_DESCRIPTION_LENGTH = 4_000;
const MAX_MAIL_SKILL_NAME_LENGTH = 100;
const MAX_MAIL_SKILL_SUBJECT_LENGTH = 200;
const MAIL_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const MAX_MAIL_BRIDGE_AGENT_SKILLS = 24;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value
    : {};
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicText(value, maximum) {
  return clean(value).slice(0, maximum);
}

function inlineText(value, maximum = 220) {
  const text = clean(value).replace(/\s+/gu, " ");
  return text.length > maximum ? `${text.slice(0, Math.max(0, maximum - 1))}…` : text;
}

function quotedLines(value) {
  return clean(value)
    .split(/\r?\n/gu)
    .map((line) => `> ${line}`)
    .join("\n");
}

function configPath(dataRoot) {
  const root = clean(dataRoot);
  if (!root || !path.isAbsolute(root)) return "";
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...MAIL_BRIDGE_CONFIG_PATH);
  return inside(resolvedRoot, target) ? target : "";
}

function mailSkillId(value) {
  const id = clean(value).toLowerCase();
  return MAIL_SKILL_ID.test(id) ? id : "";
}

function normalizedMailSkill(value, { fallbackId = "" } = {}) {
  const source = plainObject(value);
  const id = mailSkillId(source.id || fallbackId);
  const name = publicText(source.name, MAX_MAIL_SKILL_NAME_LENGTH);
  const description = publicText(source.description, MAX_MAIL_SKILL_DESCRIPTION_LENGTH);
  const subject = publicText(source.subject, MAX_MAIL_SKILL_SUBJECT_LENGTH);
  return id && name && description && subject
    ? Object.freeze({ id, name, description, subject })
    : null;
}

function legacyMailSkill(value) {
  const source = plainObject(plainObject(value).agentDelivery);
  return normalizedMailSkill({
    id: LEGACY_MAIL_SKILL_ID,
    name: source.subject,
    description: source.description,
    subject: source.subject,
  });
}

function runtimeSkillName(skill) {
  return `suzu-mail-${skill.id}`;
}

function businessSkill(skill) {
  const title = inlineText(skill.name, MAX_MAIL_SKILL_NAME_LENGTH);
  const subject = JSON.stringify(skill.subject);
  return Object.freeze({
    name: runtimeSkillName(skill),
    description: `${title}：${inlineText(skill.description, 400)}；发送主题为“${inlineText(skill.subject, 160)}”的邮件。`,
    content: [
      `# ${title}`,
      "",
      "当前任务符合下面说明时，使用这个邮件业务 Skill。",
      "",
      "## 什么时候使用",
      "",
      quotedLines(skill.description),
      "",
      "## 发送邮件",
      "",
      "先读取 `suzu-mail-bridge`，了解邮件的发送方式和结果含义。",
      "",
      `随后按其中的方式发送一封主题为 ${subject} 的邮件。邮件正文写清本轮需要对方处理的信息；不要发送空邮件。`,
    ].join("\n"),
  });
}

/**
 * Returns user-authored business Skills that tell the Agent when it should
 * send mail and which subject belongs to that business action. Mailbox
 * connection details remain private to the product runtime.
 */
export function mailBridgeAgentSkills(value) {
  const source = plainObject(value);
  const skills = [];
  const seen = new Set();
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(source.agentSkills)
      ? source.agentSkills
      : [];
  for (const candidate of candidates.slice(0, MAX_MAIL_BRIDGE_AGENT_SKILLS)) {
    const skill = normalizedMailSkill(candidate);
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    skills.push(skill);
  }
  if (skills.length) return Object.freeze(skills);
  const legacy = legacyMailSkill(source);
  return legacy ? Object.freeze([legacy]) : Object.freeze([]);
}

/**
 * Produces Core-compatible runtime Skill entries. Runtime names remain ASCII
 * because Agent Core validates Skill names; the user-facing name is presented
 * in the catalog and the Skill body.
 */
export function mailBridgeAgentBusinessSkills(value) {
  return Object.freeze(mailBridgeAgentSkills(value).map((skill) => businessSkill(skill)));
}

/**
 * Reads only user-authored mail Skill metadata from product configuration. An
 * unreadable or unsafe file simply leaves the optional capability unavailable.
 */
export async function readMailBridgeAgentSkills({ dataRoot, fsOps = fs } = {}) {
  const target = configPath(dataRoot);
  if (!target || typeof fsOps?.lstat !== "function" || typeof fsOps?.readFile !== "function") {
    return mailBridgeAgentSkills({});
  }
  try {
    const stat = await fsOps.lstat(target);
    if (!stat?.isFile?.() || stat?.isSymbolicLink?.()) return mailBridgeAgentSkills({});
    return mailBridgeAgentSkills(JSON.parse(await fsOps.readFile(target, "utf8")));
  } catch {
    return mailBridgeAgentSkills({});
  }
}
