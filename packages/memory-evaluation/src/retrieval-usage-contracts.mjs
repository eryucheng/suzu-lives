function clean(value) {
  return String(value ?? "").trim();
}

export const RETRIEVAL_USAGE_PROMPT_VERSION = "retrieval-usage-v1";
export const RETRIEVAL_USAGE_SCHEMA_NAME = "memory-retrieval-usage-v1";
export const RETRIEVAL_USAGE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["analyses"],
  properties: {
    analyses: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memoryId", "usage", "rationale"],
        properties: {
          memoryId: { type: "string", minLength: 1 },
          usage: { type: "string", enum: ["used", "not_used", "uncertain"] },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

export function buildRetrievalUsageInput({ trace, memories, responseText } = {}) {
  return `${JSON.stringify({
    policy: {
      judgeOnlyFinalResponse: true,
      hiddenReasoningAvailable: false,
      everyMemoryMustBeClassified: true,
      notUsedDoesNotMeanIrrelevant: true,
      noHelpfulnessOrCorrectnessJudgment: true,
    },
    trace: {
      id: clean(trace?.id),
      query: clean(trace?.query_text),
      recallIntent: clean(trace?.recall_intent),
      selectedMemoryIds: Array.isArray(trace?.selectedIds) ? trace.selectedIds : [],
    },
    memories: (Array.isArray(memories) ? memories : []).map((memory) => ({
      id: clean(memory?.id),
      kind: clean(memory?.kind),
      title: clean(memory?.title),
      content: clean(memory?.content),
      subjectRole: clean(memory?.subject_role),
      subjectKey: clean(memory?.subject_key),
      eventDate: clean(memory?.event_date),
      eventStart: clean(memory?.event_start),
      validFrom: clean(memory?.valid_from),
      validTo: clean(memory?.valid_to),
    })),
    assistantResponse: clean(responseText),
  })}\n`;
}

export function parseRetrievalUsageGeneration(value, { expectedMemoryIds = [] } = {}) {
  let parsed = value;
  if (typeof value === "string") {
    const text = value.trim().replace(/^```(?:json)?\s*|\s*```$/giu, "");
    try { parsed = JSON.parse(text); } catch (error) {
      throw new Error(`Retrieval usage output is not valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.analyses)) {
    throw new Error("Retrieval usage output must contain only analyses.");
  }
  const expected = [...new Set(expectedMemoryIds.map(clean).filter(Boolean))].sort();
  const seen = new Set();
  const analyses = parsed.analyses.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "memoryId,rationale,usage") {
      throw new Error(`Retrieval usage analyses[${index}] has an invalid shape.`);
    }
    const memoryId = clean(item.memoryId);
    const usage = clean(item.usage);
    const rationale = clean(item.rationale);
    if (!memoryId || seen.has(memoryId) || !["used", "not_used", "uncertain"].includes(usage)
      || !rationale) {
      throw new Error(`Retrieval usage analyses[${index}] is invalid.`);
    }
    seen.add(memoryId);
    return { memoryId, usage, rationale };
  });
  if (analyses.map((item) => item.memoryId).sort().join("\u001f") !== expected.join("\u001f")) {
    throw new Error("Retrieval usage output must classify every selected memory exactly once.");
  }
  return { analyses };
}
