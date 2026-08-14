function clean(value) {
  return String(value ?? "").trim();
}

export const MEMORY_RELATION_OUTPUT_SCHEMA = Object.freeze({
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
          "relation", "fromMemoryId", "toMemoryId",
          "evidenceSourceIds", "confidence", "rationale",
        ],
        properties: {
          relation: { type: "string", enum: ["causes"] },
          fromMemoryId: { type: "string", minLength: 1 },
          toMemoryId: { type: "string", minLength: 1 },
          evidenceSourceIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

export function buildRelationGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Memory relation generation requires a snapshot object.");
  }
  return [
    "请根据以下受限记忆与原始证据提出因果关系候选。只输出符合 Schema 的 JSON。",
    "候选只供人工审核，不会由你直接写入记忆图。",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

export function parseRelationGeneration(value, { maximumProposals = 20 } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Memory relation generator returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Memory relation generator did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memory relation generator output must be an object.");
  }
  if (!Array.isArray(parsed.proposals)) {
    throw new Error("Memory relation generator output requires a proposals array.");
  }
  const limit = Math.min(100, Math.max(0, Math.trunc(Number(maximumProposals) || 20)));
  if (parsed.proposals.length > limit) {
    throw new Error(`Memory relation generator returned more than ${limit} proposals.`);
  }
  return {
    proposals: parsed.proposals.map((proposal, index) => {
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        throw new Error(`Relation proposal ${index} must be an object.`);
      }
      return {
        relation: clean(proposal.relation),
        fromMemoryId: clean(proposal.fromMemoryId),
        toMemoryId: clean(proposal.toMemoryId),
        evidenceSourceIds: Array.isArray(proposal.evidenceSourceIds)
          ? [...new Set(proposal.evidenceSourceIds.map(clean).filter(Boolean))]
          : [],
        confidence: proposal.confidence,
        rationale: clean(proposal.rationale),
      };
    }),
  };
}
