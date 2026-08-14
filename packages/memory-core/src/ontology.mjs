const values = (items) => Object.freeze([...items]);

export const MEMORY_KINDS = values([
  "utterance",
  "event",
  "episode",
  "fact",
  "belief_state",
  "preference",
  "relationship",
  "plan",
  "commitment",
  "open_loop",
  "derived_hypothesis",
  "topic",
  "topic_or_episode",
  "reflection",
]);

export const BIG_NEURON_KINDS = values([
  "episode",
  "topic",
]);

export const LEGACY_MEMORY_KINDS = values([
  "topic_or_episode",
]);

export const DIRECT_INGESTION_MEMORY_KINDS = values(MEMORY_KINDS.filter((kind) => ![
  "utterance",
  "derived_hypothesis",
  "episode",
  "topic",
  "topic_or_episode",
].includes(kind)));

export const SUBJECT_ROLES = values([
  "user",
  "agent",
  "shared",
  "other",
  "world",
  "unknown",
]);

export const REALITY_STATES = values([
  "real",
  "hypothetical",
  "fictional",
  "roleplay",
  "unknown",
]);

export const EVIDENCE_MODES = values([
  "explicit",
  "observed",
  "inferred",
  "manual",
  "imported",
]);

export const TEMPORAL_STATES = values([
  "current",
  "historical",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
  "timeless",
  "unknown",
]);

export const REVISION_ACTIONS = values([
  "add",
  "reinforce",
  "update",
  "correct",
  "contradict",
  "complete",
  "cancel",
]);

export const REPRESENTATION_LAYERS = values([
  "unspecified",
  "reported",
  "inferred",
  "established",
]);

export const MEMORY_ACTOR_ROLES = values([
  "subject",
  "experiencer",
  "speaker",
  "observer",
  "participant",
  "belief_holder",
  "preference_holder",
]);

export const SOURCE_AUTHORITIES = values([
  "verbatim_record",
  "subject_firsthand",
  "participant_firsthand",
  "direct_observation",
  "external_record",
  "hearsay",
  "model_inference",
  "manual",
  "legacy_unknown",
  "unknown",
]);

export const MEMORY_STATE_FAMILIES = values([
  "identity",
  "belief",
  "preference",
  "habit",
  "disposition",
  "value",
  "goal",
  "capability",
  "relationship",
  "affective_association",
  "self_concept",
  "condition",
]);

export const MEMORY_STATE_FAMILY_STORAGE_VALUES = values([
  "not_applicable",
  "unspecified",
  ...MEMORY_STATE_FAMILIES,
]);

export const MEMORY_STATE_PHASES = values([
  "not_applicable",
  "unspecified",
  "active",
  "paused",
  "interrupted",
  "completed",
  "cancelled",
  "ended",
  "retired",
]);

export const REPORTED_STATE_PROPOSAL_ACTIONS = values([
  "create",
  "reinforce",
  "narrow_scope",
  "add_scoped_exception",
  "supersede",
  "pause",
  "resume",
  "progress_update",
  "complete",
  "cancel",
  "end",
  "retire",
  "interrupt",
  "stop",
  "revoke",
  "correct_attribution",
]);

export const REPORTED_STATE_ACTIONS_BY_FAMILY = Object.freeze({
  identity: values(["create", "reinforce", "narrow_scope", "supersede", "retire", "correct_attribution"]),
  belief: values(["create", "reinforce", "narrow_scope", "supersede", "correct_attribution"]),
  preference: values(["create", "reinforce", "narrow_scope", "add_scoped_exception", "supersede", "correct_attribution"]),
  habit: values(["create", "reinforce", "narrow_scope", "supersede", "interrupt", "stop", "correct_attribution"]),
  disposition: values(["create", "reinforce", "narrow_scope", "add_scoped_exception", "supersede", "correct_attribution"]),
  value: values(["create", "reinforce", "narrow_scope", "supersede"]),
  goal: values(["create", "reinforce", "pause", "resume", "progress_update", "complete", "cancel", "supersede"]),
  capability: values(["create", "reinforce", "narrow_scope", "supersede", "retire"]),
  relationship: values(["create", "reinforce", "narrow_scope", "supersede", "revoke"]),
  affective_association: values(["create", "reinforce", "narrow_scope", "supersede", "retire", "correct_attribution"]),
  self_concept: values(["create", "reinforce", "narrow_scope", "supersede", "correct_attribution"]),
  condition: values(["create", "reinforce", "narrow_scope", "supersede", "end", "correct_attribution"]),
});

export function isReportedStateActionAllowedForFamily(action, stateFamily) {
  return REPORTED_STATE_ACTIONS_BY_FAMILY[stateFamily]?.includes(action) || false;
}

export const MEMORY_STATE_FAMILY_ALLOWED_KINDS = Object.freeze({
  identity: values(["fact", "derived_hypothesis"]),
  belief: values(["belief_state"]),
  preference: values(["preference", "derived_hypothesis"]),
  habit: values(["belief_state", "derived_hypothesis"]),
  disposition: values(["belief_state", "derived_hypothesis"]),
  value: values(["belief_state", "derived_hypothesis"]),
  goal: values(["plan", "commitment", "open_loop"]),
  capability: values(["fact", "derived_hypothesis"]),
  relationship: values(["relationship"]),
  affective_association: values(["belief_state", "derived_hypothesis"]),
  self_concept: values(["belief_state"]),
  condition: values(["fact", "derived_hypothesis"]),
});

export const MEMORY_STATE_FAMILY_DEFINITIONS = Object.freeze({
  identity: Object.freeze({ status: "transitional", description: "身份与生平事实。" }),
  belief: Object.freeze({ status: "transitional", description: "主体当前或历史的观念与看法。" }),
  preference: Object.freeze({ status: "transitional", description: "可选择条件下的喜好与厌恶。" }),
  habit: Object.freeze({ status: "transitional", description: "有条件和场景范围的重复行为规律。" }),
  disposition: Object.freeze({ status: "transitional", description: "跨情境的行为、交流、决策与应对倾向。" }),
  value: Object.freeze({ status: "transitional", description: "由明确原则和真实取舍共同校准的价值与优先级。" }),
  goal: Object.freeze({ status: "transitional", description: "目标、意图、承诺与未完事项。" }),
  capability: Object.freeze({ status: "transitional", description: "保留任务范围、表现结果、独立程度与依赖条件的能力和熟练度。" }),
  relationship: Object.freeze({ status: "transitional", description: "人物之间有方向、有观点主体和范围的角色、信任、边界与共识。" }),
  affective_association: Object.freeze({ status: "transitional", description: "保留触发对象、体验主体、情绪类型、直接关联依据与时间变化的情绪联结。" }),
  self_concept: Object.freeze({ status: "transitional", description: "主体本人表达的自我认识、角色理解与人生叙事。" }),
  condition: Object.freeze({ status: "transitional", description: "有时间和情境范围的现实条件、需求与约束。" }),
});

export const RETRIEVAL_FEEDBACK_SIGNALS = values([
  "used",
  "helpful",
  "irrelevant",
  "incorrect",
  "missed",
  "corrected",
]);

export const MEMORY_KIND_DEFINITIONS = Object.freeze({
  utterance: Object.freeze({
    layer: "evidence",
    stateful: false,
    description: "可以逐字核对的用户或 Agent 原话。",
  }),
  event: Object.freeze({
    layer: "episodic",
    stateful: false,
    description: "在某个时间发生、持续或计划发生的具体经历。",
  }),
  episode: Object.freeze({
    layer: "episodic",
    stateful: false,
    description: "由多个具体记忆组成、具有现实时间边界的事件簇。",
  }),
  fact: Object.freeze({
    layer: "semantic",
    stateful: true,
    description: "关于某个主体、当前可成立并可能随时间变化的事实。",
  }),
  belief_state: Object.freeze({
    layer: "semantic",
    stateful: true,
    description: "某个主体在一段有效期内持有、可被后续经历修正的理解。",
  }),
  preference: Object.freeze({
    layer: "semantic",
    stateful: true,
    description: "主体明确表达或经选择证据支持的喜好与厌恶，不包含单纯习惯。",
  }),
  relationship: Object.freeze({
    layer: "relational",
    stateful: true,
    description: "人物之间的关系、称呼、边界和关系状态。",
  }),
  plan: Object.freeze({
    layer: "prospective",
    stateful: true,
    description: "主体想要在未来完成的行动或目标。",
  }),
  commitment: Object.freeze({
    layer: "prospective",
    stateful: true,
    description: "主体已经答应或共同约定要完成的事情。",
  }),
  open_loop: Object.freeze({
    layer: "prospective",
    stateful: true,
    description: "已经开始但仍未完成、需要回访或等待结果的事情。",
  }),
  derived_hypothesis: Object.freeze({
    layer: "semantic",
    stateful: true,
    description: "由多条证据推导、保留反例并可被推翻的候选认识。",
  }),
  topic: Object.freeze({
    layer: "semantic",
    stateful: false,
    description: "由多条记忆支持、可跨越多个事件的稳定语义主题。",
  }),
  topic_or_episode: Object.freeze({
    layer: "structural",
    stateful: false,
    description: "旧版本中未区分事件簇与语义主题的兼容节点；不得用于新数据。",
  }),
  reflection: Object.freeze({
    layer: "reflective",
    stateful: false,
    description: "Agent 对经历形成的看法、理解或自我反思，不冒充外部事实。",
  }),
});

export function memoryLayerForKind(kind) {
  return MEMORY_KIND_DEFINITIONS[String(kind || "").trim()]?.layer || "";
}

export function isStatefulMemoryKind(kind) {
  return Boolean(MEMORY_KIND_DEFINITIONS[String(kind || "").trim()]?.stateful);
}

export function isMemoryKindAllowedForStateFamily(kind, stateFamily) {
  const normalizedFamily = String(stateFamily || "").trim();
  if (normalizedFamily === "unspecified") return isStatefulMemoryKind(kind);
  return Boolean(MEMORY_STATE_FAMILY_ALLOWED_KINDS[normalizedFamily]
    ?.includes(String(kind || "").trim()));
}

export function isBigNeuronKind(kind) {
  return BIG_NEURON_KINDS.includes(String(kind || "").trim());
}

export function isLegacyMemoryKind(kind) {
  return LEGACY_MEMORY_KINDS.includes(String(kind || "").trim());
}
