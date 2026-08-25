const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const ACTION_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const SKILL_PREFIX = "suzu-";
const MAX_DESCRIPTION_LENGTH = 600;
const FOLLOW_UP_SKILL_NAME = "suzu-follow-up";
const FOLLOW_UP_SKILL_DESCRIPTION = "在当前对话出现明确的会在短期内继续发展的事情时，为当前联系人创建并维护回访。";

const FOLLOW_UP_SKILL_CONTENT = [
  "# 回访",
  "",
  "把当前对话中有明确后续节点的事情安排为一次回访，让之后的联系自然接上这段对话。",
  "",
  "## 判断时机",
  "",
  "当前联系人提到已有约定、正在等待的结果、即将发生的安排或之后希望继续交流的事项时，结合这段关系的相处方式判断回访时刻。",
  "",
  "## 创建回访",
  "",
  "一条回访对应一件具体事情。先读取 `suzu-schedule`，再创建一条使用 `delay` 的定时任务。",
  "",
  "- `description` 写成简短的回访事项，便于之后识别。",
  "- `prompt` 写清事情背景、需要关注的进展和适合继续交流的方向。",
  "- 任务自动关联当前联系人。",
  "",
  "## 维护回访",
  "",
  "当对话再次出现这件事时，读取 `suzu-schedule` 中当前联系人的待执行任务，按事项找到对应条目。",
  "",
  "- 进展仍在继续时，保留或调整回访内容与时刻。",
  "- 联系人已经给出结果时，完成对应回访。",
  "- 同一事项持续维护同一条回访。",
  "",
  "## 到点处理",
  "",
  "回访到点后，依据保存的背景和当前关系语境自然继续这段对话。",
].join("\n");

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, limit = MAX_DESCRIPTION_LENGTH) {
  const text = clean(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function capabilitySkillName(capabilityId) {
  const id = clean(capabilityId);
  return CAPABILITY_ID.test(id) ? `${SKILL_PREFIX}${id}` : "";
}

function normalizedActions(value) {
  const grouped = new Map();
  for (const candidate of Array.isArray(value) ? value : []) {
    const source = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
    const capabilityId = clean(source.capabilityId);
    const action = clean(source.action);
    const capabilityName = clean(source.capabilityName);
    const capabilityDescription = bounded(source.capabilityDescription);
    const actionName = clean(source.actionName);
    const actionDescription = bounded(source.actionDescription || source.description);
    if (!CAPABILITY_ID.test(capabilityId) || !ACTION_ID.test(action) || !capabilityName || !actionDescription) continue;
    const entry = Object.freeze({
      capabilityId,
      capabilityName,
      capabilityDescription,
      action,
      actionName: actionName || action,
      actionDescription,
    });
    const group = grouped.get(capabilityId) || {
      capabilityId,
      capabilityName,
      capabilityDescription,
      actions: [],
    };
    group.actions.push(entry);
    grouped.set(capabilityId, group);
  }
  return [...grouped.values()]
    .map((group) => Object.freeze({
      ...group,
      actions: Object.freeze([...group.actions].sort((left, right) => left.action.localeCompare(right.action, "en"))),
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId, "en"));
}

function summaryFor(group) {
  return group.capabilityDescription
    ? `${group.capabilityName}：${group.capabilityDescription}`
    : group.capabilityName;
}

function followUpSkillFor(groups) {
  const schedule = scheduleSkillGroup(groups);
  if (!schedule) return null;
  return Object.freeze({
    name: FOLLOW_UP_SKILL_NAME,
    description: FOLLOW_UP_SKILL_DESCRIPTION,
    content: FOLLOW_UP_SKILL_CONTENT,
  });
}

function scheduleSkillGroup(groups) {
  const schedule = groups.find((group) => group.capabilityId === "schedule");
  const actions = new Set((schedule?.actions || []).map((action) => action.action));
  return ["add", "list", "remove"].every((action) => actions.has(action)) ? schedule : null;
}

function scheduleSkillFor(groups) {
  if (!scheduleSkillGroup(groups)) return null;
  return Object.freeze({
    name: "suzu-schedule",
    description: "计划：创建和维护当前联系人的对话定时任务。",
    content: [
      "# 定时任务",
      "",
      "管理当前联系人由 Agent 创建的对话定时任务。",
      "",
      "## 查看任务",
      "",
      "先调用 `suzu_capability`，使用 `capabilityId: \"schedule\"`、`action: \"list\"`。input 留空。结果中的 `id`、`description` 和触发时间用于识别对应事项。",
      "",
      "## 取消任务",
      "",
      "先查看任务，按事项找到对应 `id`，再调用 `suzu_capability`，使用 `capabilityId: \"schedule\"`、`action: \"remove\"`，并提供 `input: { id: \"任务 ID\" }`。",
      "",
      "## 调整任务",
      "",
      "先查看原任务。创建新的任务并确认创建结果后，取消原任务，使该事项保持一个当前有效的后续安排。",
      "",
      "## 创建任务",
      "",
      "调用 `suzu_capability`，使用 `capabilityId: \"schedule\"`、`action: \"add\"`。input 包含：",
      "",
      "- `prompt`：到点后需要处理的事项。",
      "- `description`：简短说明，方便之后识别。",
      "- `delay`：一次性任务从当前时刻到触发时刻的间隔。",
      "- `cron`：具有稳定重复规律的任务使用的 5 段表达式。",
    ].join("\n"),
  });
}

function mailBridgeGuidance(group) {
  if (group.capabilityId !== "mail-bridge") return "";
  return [
    "## 邮件业务 Skill",
    "",
    "先从技能目录读取与当前任务匹配的邮件业务 Skill，例如“查岗”。它会说明使用时机和邮件主题。没有匹配的业务 Skill 时，不要根据普通对话自行猜测用途或主题。",
    "",
    "## 发信",
    "",
    "业务 Skill 给出主题后，调用 `suzu_capability`，使用 `capabilityId: \"mail-bridge\"`、`action: \"send\"`，并提供 `input: { subject: \"业务 Skill 指定的主题\", content: \"邮件正文\" }`。收件地址由软件配置决定，不可由 Agent 修改。",
    "",
    "发送成功仅表示邮件已提交给 SMTP 服务器；不要把它当作对方已经处理完成。",
  ].join("\n");
}

function supplementalContentFor(group, detailsByCapability) {
  const details = detailsByCapability && typeof detailsByCapability === "object" && !Array.isArray(detailsByCapability)
    ? detailsByCapability
    : {};
  return clean(details[group.capabilityId]);
}

function contentFor(group, { detailsByCapability = {} } = {}) {
  const actions = group.actions.map((action) => [
    `### ${action.actionName}`,
    "",
    `- capabilityId：\`${action.capabilityId}\``,
    `- action：\`${action.action}\``,
    `- ${action.actionDescription}`,
  ].join("\n"));
  return [
    `# ${group.capabilityName}`,
    "",
    group.capabilityDescription || "当前联系人可使用的产品能力。",
    "",
    ...(mailBridgeGuidance(group) ? [mailBridgeGuidance(group), ""] : []),
    ...(supplementalContentFor(group, detailsByCapability) ? [supplementalContentFor(group, detailsByCapability), ""] : []),
    "## 使用方式",
    "",
    "调用 `suzu_capability` 时，将目标动作的 capabilityId 和 action 原样填入；input 按该动作的说明提供。",
    "",
    "## 可用动作",
    "",
    ...actions,
  ].join("\n");
}

/**
 * Turn the currently enabled product action declarations into Core Skills.
 * The short catalog is safe to place in every model step; per-action input
 * contracts remain behind the native `skill` tool until the model selects the
 * matching capability.
 */
export function capabilitySkillCatalog(actions = []) {
  const groups = normalizedActions(actions);
  const skills = groups.map((group) => Object.freeze({
    name: capabilitySkillName(group.capabilityId),
    description: summaryFor(group),
  }));
  const followUp = followUpSkillFor(groups);
  if (followUp) skills.push(Object.freeze({ name: followUp.name, description: followUp.description }));
  return Object.freeze(skills.sort((left, right) => left.name.localeCompare(right.name, "en")));
}

export function capabilitySkillForName(actions = [], name = "", { detailsByCapability = {} } = {}) {
  const requestedName = clean(name);
  const groups = normalizedActions(actions);
  const followUp = followUpSkillFor(groups);
  if (followUp?.name === requestedName) return followUp;
  const schedule = scheduleSkillFor(groups);
  if (schedule?.name === requestedName) return schedule;
  const group = groups.find((candidate) => (
    capabilitySkillName(candidate.capabilityId) === requestedName
  ));
  if (!group) return null;
  return Object.freeze({
    name: capabilitySkillName(group.capabilityId),
    description: summaryFor(group),
    content: contentFor(group, { detailsByCapability }),
  });
}
