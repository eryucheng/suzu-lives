function clean(value) {
  return String(value ?? "").trim();
}

export const MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "decision", "subjectRole", "subjectKey", "sourceIds",
    "actorRoles", "confidence", "rationale",
  ],
  properties: {
    decision: { type: "string", enum: ["propose", "abstain"] },
    subjectRole: {
      type: "string",
      enum: ["", "user", "agent", "shared", "other", "world"],
    },
    subjectKey: { type: "string" },
    sourceIds: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    actorRoles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "role", "actorRole", "actorKey", "isPrimary", "confidence", "sourceIds",
        ],
        properties: {
          role: {
            type: "string",
            enum: [
              "experiencer", "speaker", "observer", "participant",
              "belief_holder", "preference_holder",
            ],
          },
          actorRole: {
            type: "string",
            enum: ["user", "agent", "shared", "other", "world"],
          },
          actorKey: { type: "string" },
          isPrimary: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          sourceIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
});

export function buildSubjectAttributionGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Subject attribution generation requires a snapshot.");
  }
  return JSON.stringify(snapshot);
}

export function parseSubjectAttributionGeneration(output) {
  let parsed = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error(`Subject attribution output is not valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Subject attribution output must be an object.");
  }
  const decision = clean(parsed.decision);
  if (!["propose", "abstain"].includes(decision)) {
    throw new Error("Subject attribution decision must be propose or abstain.");
  }
  if (decision === "abstain") {
    return {
      decision,
      subjectRole: "",
      subjectKey: "",
      sourceIds: [],
      actorRoles: [],
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
      rationale: clean(parsed.rationale) || "Evidence is not sufficient.",
    };
  }
  return {
    decision,
    subjectRole: clean(parsed.subjectRole),
    subjectKey: clean(parsed.subjectKey),
    sourceIds: Array.isArray(parsed.sourceIds) ? parsed.sourceIds.map(clean).filter(Boolean) : [],
    actorRoles: Array.isArray(parsed.actorRoles) ? parsed.actorRoles.map((role) => ({
      role: clean(role?.role),
      actorRole: clean(role?.actorRole),
      actorKey: clean(role?.actorKey),
      isPrimary: Boolean(role?.isPrimary),
      confidence: Number(role?.confidence),
      sourceIds: Array.isArray(role?.sourceIds)
        ? role.sourceIds.map(clean).filter(Boolean)
        : [],
    })) : [],
    confidence: Number(parsed.confidence),
    rationale: clean(parsed.rationale),
  };
}
