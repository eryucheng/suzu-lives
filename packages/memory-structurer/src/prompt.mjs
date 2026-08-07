function clean(value) {
  return String(value ?? "").trim();
}

const nullableString = Object.freeze({ type: ["string", "null"] });

const actorRoleSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["role", "actorRole", "actorKey", "isPrimary", "confidence"],
  properties: {
    role: {
      type: "string",
      enum: [
        "subject", "experiencer", "speaker", "observer",
        "participant", "belief_holder", "preference_holder",
      ],
    },
    actorRole: {
      type: "string",
      enum: ["user", "agent", "shared", "other", "world", "unknown"],
    },
    actorKey: { type: "string" },
    isPrimary: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

export const MEMORY_STRUCTURE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "operation", "targetMemoryId", "kind", "title", "content",
          "subjectRole", "subjectKey", "eventDate", "eventStart", "eventEnd",
          "memberIds", "actorRoles", "confidence", "rationale",
        ],
        properties: {
          operation: { type: "string", enum: ["create", "attach"] },
          targetMemoryId: { type: "string" },
          kind: { type: "string", enum: ["episode", "topic"] },
          title: { type: "string" },
          content: { type: "string" },
          subjectRole: {
            type: "string",
            enum: ["user", "agent", "shared", "other", "world", "unknown"],
          },
          subjectKey: { type: "string" },
          eventDate: nullableString,
          eventStart: nullableString,
          eventEnd: nullableString,
          memberIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          actorRoles: { type: "array", items: actorRoleSchema },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
        },
      },
    },
  },
});

export function buildStructureGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Memory structure generation requires a snapshot object.");
  }
  return [
    "请根据以下受限记忆快照提出结构候选。只输出符合 Schema 的 JSON。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

export function parseStructureGeneration(value, { maximumProposals = 20 } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Memory structure generator returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Memory structure generator did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memory structure generator output must be an object.");
  }
  if (!Array.isArray(parsed.proposals)) {
    throw new Error("Memory structure generator output requires a proposals array.");
  }
  const limit = Math.min(100, Math.max(0, Math.trunc(Number(maximumProposals) || 20)));
  if (parsed.proposals.length > limit) {
    throw new Error(`Memory structure generator returned more than ${limit} proposals.`);
  }
  return {
    proposals: parsed.proposals.map((proposal, index) => {
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        throw new Error(`Structure proposal ${index} must be an object.`);
      }
      return {
        operation: clean(proposal.operation),
        targetMemoryId: clean(proposal.targetMemoryId),
        kind: clean(proposal.kind),
        title: clean(proposal.title),
        content: clean(proposal.content),
        subjectRole: clean(proposal.subjectRole) || "unknown",
        subjectKey: clean(proposal.subjectKey),
        eventDate: clean(proposal.eventDate) || null,
        eventStart: clean(proposal.eventStart) || null,
        eventEnd: clean(proposal.eventEnd) || null,
        memberIds: Array.isArray(proposal.memberIds) ? proposal.memberIds.map(clean).filter(Boolean) : [],
        actorRoles: Array.isArray(proposal.actorRoles) ? proposal.actorRoles : [],
        confidence: proposal.confidence,
        rationale: clean(proposal.rationale),
      };
    }),
  };
}
