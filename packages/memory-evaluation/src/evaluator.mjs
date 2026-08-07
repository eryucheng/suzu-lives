import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

function stringArray(value, field, { allowEmpty = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组。`);
  const values = value.map((item) => clean(item));
  if (values.some((item) => !item)) throw new Error(`${field} 不能包含空字符串。`);
  if (!allowEmpty && !values.length) throw new Error(`${field} 不能为空。`);
  return values;
}

function oneOrMany(value, field) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return stringArray(value, field, { allowEmpty: false });
  const normalized = clean(value);
  if (!normalized) throw new Error(`${field} 不能为空。`);
  return [normalized];
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined) return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${field} 必须是非负整数。`);
  }
  return normalized;
}

function normalizeSubjectExpectation(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expect.expectedSubjects[${index}] 必须是对象。`);
  }
  const memoryId = clean(value.memoryId);
  const role = clean(value.role);
  const key = clean(value.key);
  if (!memoryId) throw new Error(`expect.expectedSubjects[${index}].memoryId 不能为空。`);
  if (!role && !key) {
    throw new Error(`expect.expectedSubjects[${index}] 至少需要 role 或 key。`);
  }
  return { memoryId, role, key };
}

function normalizePrimarySubject(value, field) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  const role = clean(value.role);
  const key = clean(value.key);
  if (!role && !key) throw new Error(`${field} 至少需要 role 或 key。`);
  return { role, key };
}

export function normalizeEvaluationCase(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`cases[${index}] 必须是对象。`);
  }
  const id = clean(value.id);
  const query = clean(value.query);
  const category = clean(value.category) || "uncategorized";
  if (!id) throw new Error(`cases[${index}].id 不能为空。`);
  if (!query) throw new Error(`cases[${index}].query 不能为空。`);
  const expectation = value.expect;
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) {
    throw new Error(`cases[${index}].expect 必须是对象。`);
  }
  const expectedSubjects = expectation.expectedSubjects === undefined
    ? []
    : expectation.expectedSubjects.map(normalizeSubjectExpectation);
  return {
    id,
    title: clean(value.title) || id,
    category,
    query,
    anchorMemoryIds: stringArray(value.anchorMemoryIds, `cases[${index}].anchorMemoryIds`),
    now: clean(value.now),
    tags: stringArray(value.tags, `cases[${index}].tags`),
    expect: {
      statuses: oneOrMany(expectation.status, `cases[${index}].expect.status`),
      recallIntents: oneOrMany(
        expectation.recallIntent,
        `cases[${index}].expect.recallIntent`,
      ),
      chainModes: oneOrMany(expectation.chainMode, `cases[${index}].expect.chainMode`),
      chainDirections: oneOrMany(
        expectation.chainDirection,
        `cases[${index}].expect.chainDirection`,
      ),
      retrievalModes: oneOrMany(
        expectation.retrievalMode,
        `cases[${index}].expect.retrievalMode`,
      ),
      disclosureLevels: oneOrMany(
        expectation.disclosureLevel,
        `cases[${index}].expect.disclosureLevel`,
      ),
      primaryMemoryIds: stringArray(
        expectation.primaryMemoryIds,
        `cases[${index}].expect.primaryMemoryIds`,
      ),
      requiredMemoryIds: stringArray(
        expectation.requiredMemoryIds,
        `cases[${index}].expect.requiredMemoryIds`,
      ),
      forbiddenMemoryIds: stringArray(
        expectation.forbiddenMemoryIds,
        `cases[${index}].expect.forbiddenMemoryIds`,
      ),
      requiredEvidenceIds: stringArray(
        expectation.requiredEvidenceIds,
        `cases[${index}].expect.requiredEvidenceIds`,
      ),
      requiredSupportEvidenceIds: stringArray(
        expectation.requiredSupportEvidenceIds,
        `cases[${index}].expect.requiredSupportEvidenceIds`,
      ),
      requiredCounterevidenceIds: stringArray(
        expectation.requiredCounterevidenceIds,
        `cases[${index}].expect.requiredCounterevidenceIds`,
      ),
      forbiddenEvidenceIds: stringArray(
        expectation.forbiddenEvidenceIds,
        `cases[${index}].expect.forbiddenEvidenceIds`,
      ),
      requiredSubjectRejectedIds: stringArray(
        expectation.requiredSubjectRejectedIds,
        `cases[${index}].expect.requiredSubjectRejectedIds`,
      ),
      requiredGraphSubjectRejectedIds: stringArray(
        expectation.requiredGraphSubjectRejectedIds,
        `cases[${index}].expect.requiredGraphSubjectRejectedIds`,
      ),
      requiredStateSuppressedIds: stringArray(
        expectation.requiredStateSuppressedIds,
        `cases[${index}].expect.requiredStateSuppressedIds`,
      ),
      contextIncludes: stringArray(
        expectation.contextIncludes,
        `cases[${index}].expect.contextIncludes`,
      ),
      contextExcludes: stringArray(
        expectation.contextExcludes,
        `cases[${index}].expect.contextExcludes`,
      ),
      expectedSubjects,
      primarySubject: normalizePrimarySubject(
        expectation.primarySubject,
        `cases[${index}].expect.primarySubject`,
      ),
      emptyContext: expectation.emptyContext === undefined
        ? undefined
        : Boolean(expectation.emptyContext),
      maximumContextChars: optionalNonNegativeInteger(
        expectation.maximumContextChars,
        `cases[${index}].expect.maximumContextChars`,
      ),
      minimumSelectedMemories: optionalNonNegativeInteger(
        expectation.minimumSelectedMemories,
        `cases[${index}].expect.minimumSelectedMemories`,
      ),
      maximumSelectedMemories: optionalNonNegativeInteger(
        expectation.maximumSelectedMemories,
        `cases[${index}].expect.maximumSelectedMemories`,
      ),
      maximumCandidates: optionalNonNegativeInteger(
        expectation.maximumCandidates,
        `cases[${index}].expect.maximumCandidates`,
      ),
    },
  };
}

function isNormalizedEvaluationCase(value) {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray(value.expect?.statuses)
    && Array.isArray(value.expect?.requiredMemoryIds),
  );
}

function loadJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  return JSON.parse(text);
}

export function loadEvaluationCases(filePath) {
  const resolved = path.resolve(filePath);
  const document = loadJson(resolved);
  const rawCases = Array.isArray(document) ? document : document?.cases;
  if (!Array.isArray(rawCases)) {
    throw new Error(`${resolved} 必须是案例数组，或包含 cases 数组的对象。`);
  }
  const cases = rawCases.map(normalizeEvaluationCase);
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`评测案例ID重复：${item.id}`);
    ids.add(item.id);
  }
  return {
    sourcePath: resolved,
    version: Number(Array.isArray(document) ? 1 : document.version || 1),
    description: clean(Array.isArray(document) ? "" : document.description),
    cases,
  };
}

function selectedMemoryIds(result) {
  const values = result?.graph?.selectedMemoryIds
    || result?.fragments?.flatMap((fragment) => fragment.memoryIds || [fragment.memoryId])
    || [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function disclosedEvidenceIds(result) {
  const values = result?.graph?.evidenceMemoryIds
    || result?.fragments?.flatMap((fragment) => fragment.evidenceIds || [])
    || [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function observedMemories(result) {
  const values = Array.isArray(result?.observedMemories) ? result.observedMemories : [];
  return new Map(values.map((memory) => [clean(memory.id), memory]));
}

function comparison(rule, passed, expected, actual) {
  return { rule, passed: Boolean(passed), expected, actual };
}

function includesEvery(actual, expected) {
  return expected.every((value) => actual.includes(value));
}

function excludesEvery(actual, forbidden) {
  return forbidden.every((value) => !actual.includes(value));
}

function addOneOfAssertion(assertions, rule, expected, actual) {
  if (!expected.length) return;
  assertions.push(comparison(rule, expected.includes(clean(actual)), expected, clean(actual)));
}

function contextHash(context) {
  return context
    ? createHash("sha256").update(context, "utf8").digest("hex")
    : "";
}

export function evaluateRetrievalResult(testCase, result, { includeContext = false } = {}) {
  const item = isNormalizedEvaluationCase(testCase)
    ? testCase
    : normalizeEvaluationCase(testCase);
  const expectations = item.expect;
  const context = String(result?.context || "");
  const selected = selectedMemoryIds(result);
  const evidenceIds = disclosedEvidenceIds(result);
  const supportEvidenceIds = stringArray(
    result?.graph?.supportEvidenceMemoryIds,
    "result.graph.supportEvidenceMemoryIds",
  );
  const counterevidenceIds = stringArray(
    result?.graph?.counterevidenceMemoryIds,
    "result.graph.counterevidenceMemoryIds",
  );
  const subjectRejectedIds = stringArray(
    result?.seedRouting?.subjectRouting?.hardRejectedCandidateIds,
    "result.seedRouting.subjectRouting.hardRejectedCandidateIds",
  );
  const graphSubjectRejectedIds = stringArray(
    result?.seedRouting?.subjectRouting?.hardRejectedGraphMemoryIds,
    "result.seedRouting.subjectRouting.hardRejectedGraphMemoryIds",
  );
  const stateSuppressedIds = stringArray(
    result?.seedRouting?.stateRouting?.suppressedMemoryIds,
    "result.seedRouting.stateRouting.suppressedMemoryIds",
  );
  const candidateIds = (result?.candidates || []).map((candidate) => clean(candidate.memoryId));
  const primaryMemoryId = clean(result?.graph?.seedId || result?.fragments?.[0]?.memoryId);
  const memories = observedMemories(result);
  const primaryMemory = memories.get(primaryMemoryId);
  const assertions = [];

  addOneOfAssertion(assertions, "status", expectations.statuses, result?.status);
  addOneOfAssertion(assertions, "recall-intent", expectations.recallIntents, result?.recallIntent);
  addOneOfAssertion(assertions, "chain-mode", expectations.chainModes, result?.chainIntent?.mode);
  addOneOfAssertion(
    assertions,
    "chain-direction",
    expectations.chainDirections,
    result?.chainIntent?.direction,
  );
  addOneOfAssertion(
    assertions,
    "retrieval-mode",
    expectations.retrievalModes,
    result?.retrievalMode,
  );
  addOneOfAssertion(
    assertions,
    "disclosure-level",
    expectations.disclosureLevels,
    result?.disclosureLevel,
  );
  if (expectations.primaryMemoryIds.length) {
    assertions.push(comparison(
      "primary-memory",
      expectations.primaryMemoryIds.includes(primaryMemoryId),
      expectations.primaryMemoryIds,
      primaryMemoryId,
    ));
  }
  if (expectations.requiredMemoryIds.length) {
    assertions.push(comparison(
      "required-memories",
      includesEvery(selected, expectations.requiredMemoryIds),
      expectations.requiredMemoryIds,
      selected,
    ));
  }
  if (expectations.forbiddenMemoryIds.length) {
    assertions.push(comparison(
      "forbidden-memories",
      excludesEvery(selected, expectations.forbiddenMemoryIds),
      expectations.forbiddenMemoryIds,
      selected,
    ));
  }
  if (expectations.requiredEvidenceIds.length) {
    assertions.push(comparison(
      "required-evidence",
      includesEvery(evidenceIds, expectations.requiredEvidenceIds),
      expectations.requiredEvidenceIds,
      evidenceIds,
    ));
  }
  if (expectations.requiredSupportEvidenceIds.length) {
    assertions.push(comparison(
      "required-support-evidence",
      includesEvery(supportEvidenceIds, expectations.requiredSupportEvidenceIds),
      expectations.requiredSupportEvidenceIds,
      supportEvidenceIds,
    ));
  }
  if (expectations.requiredCounterevidenceIds.length) {
    assertions.push(comparison(
      "required-counterevidence",
      includesEvery(counterevidenceIds, expectations.requiredCounterevidenceIds),
      expectations.requiredCounterevidenceIds,
      counterevidenceIds,
    ));
  }
  if (expectations.forbiddenEvidenceIds.length) {
    assertions.push(comparison(
      "forbidden-evidence",
      excludesEvery(evidenceIds, expectations.forbiddenEvidenceIds),
      expectations.forbiddenEvidenceIds,
      evidenceIds,
    ));
  }
  if (expectations.requiredSubjectRejectedIds.length) {
    assertions.push(comparison(
      "required-subject-rejections",
      includesEvery(subjectRejectedIds, expectations.requiredSubjectRejectedIds),
      expectations.requiredSubjectRejectedIds,
      subjectRejectedIds,
    ));
  }
  if (expectations.requiredGraphSubjectRejectedIds.length) {
    assertions.push(comparison(
      "required-graph-subject-rejections",
      includesEvery(graphSubjectRejectedIds, expectations.requiredGraphSubjectRejectedIds),
      expectations.requiredGraphSubjectRejectedIds,
      graphSubjectRejectedIds,
    ));
  }
  if (expectations.requiredStateSuppressedIds.length) {
    assertions.push(comparison(
      "required-state-suppressions",
      includesEvery(stateSuppressedIds, expectations.requiredStateSuppressedIds),
      expectations.requiredStateSuppressedIds,
      stateSuppressedIds,
    ));
  }
  if (expectations.contextIncludes.length) {
    assertions.push(comparison(
      "context-includes",
      includesEvery(context, expectations.contextIncludes),
      expectations.contextIncludes,
      expectations.contextIncludes.filter((value) => context.includes(value)),
    ));
  }
  if (expectations.contextExcludes.length) {
    assertions.push(comparison(
      "context-excludes",
      excludesEvery(context, expectations.contextExcludes),
      expectations.contextExcludes,
      expectations.contextExcludes.filter((value) => context.includes(value)),
    ));
  }
  if (expectations.emptyContext !== undefined) {
    assertions.push(comparison(
      "empty-context",
      expectations.emptyContext === (context.length === 0),
      expectations.emptyContext,
      context.length === 0,
    ));
  }
  if (expectations.maximumContextChars !== undefined) {
    assertions.push(comparison(
      "maximum-context-chars",
      context.length <= expectations.maximumContextChars,
      expectations.maximumContextChars,
      context.length,
    ));
  }
  if (expectations.minimumSelectedMemories !== undefined) {
    assertions.push(comparison(
      "minimum-selected-memories",
      selected.length >= expectations.minimumSelectedMemories,
      expectations.minimumSelectedMemories,
      selected.length,
    ));
  }
  if (expectations.maximumSelectedMemories !== undefined) {
    assertions.push(comparison(
      "maximum-selected-memories",
      selected.length <= expectations.maximumSelectedMemories,
      expectations.maximumSelectedMemories,
      selected.length,
    ));
  }
  if (expectations.maximumCandidates !== undefined) {
    assertions.push(comparison(
      "maximum-candidates",
      candidateIds.length <= expectations.maximumCandidates,
      expectations.maximumCandidates,
      candidateIds.length,
    ));
  }
  for (const expectation of expectations.expectedSubjects) {
    const memory = memories.get(expectation.memoryId);
    const passed = Boolean(memory)
      && (!expectation.role || clean(memory.subjectRole) === expectation.role)
      && (!expectation.key || clean(memory.subjectKey) === expectation.key);
    assertions.push(comparison(
      `subject:${expectation.memoryId}`,
      passed,
      { role: expectation.role, key: expectation.key },
      memory
        ? { role: clean(memory.subjectRole), key: clean(memory.subjectKey) }
        : null,
    ));
  }
  if (expectations.primarySubject) {
    const expectation = expectations.primarySubject;
    const passed = Boolean(primaryMemory)
      && (!expectation.role || clean(primaryMemory.subjectRole) === expectation.role)
      && (!expectation.key || clean(primaryMemory.subjectKey) === expectation.key);
    assertions.push(comparison(
      "primary-subject",
      passed,
      expectation,
      primaryMemory
        ? { role: clean(primaryMemory.subjectRole), key: clean(primaryMemory.subjectKey) }
        : null,
    ));
  }

  const actual = {
    status: clean(result?.status),
    recallIntent: clean(result?.recallIntent),
    chainMode: clean(result?.chainIntent?.mode),
    chainDirection: clean(result?.chainIntent?.direction),
    retrievalMode: clean(result?.retrievalMode),
    primaryMemoryId,
    selectedMemoryIds: selected,
    candidateMemoryIds: candidateIds,
    subjectRejectedMemoryIds: subjectRejectedIds,
    graphSubjectRejectedMemoryIds: graphSubjectRejectedIds,
    stateSuppressedMemoryIds: stateSuppressedIds,
    supportEvidenceMemoryIds: supportEvidenceIds,
    counterevidenceMemoryIds: counterevidenceIds,
    contextChars: context.length,
    contextSha256: contextHash(context),
    vectorStatus: clean(result?.vector?.status),
    searchedMemories: Number(result?.searchedMemories || 0),
    observedMemories: [...memories.values()],
  };
  if (includeContext) actual.context = context;
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    query: item.query,
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    actual,
  };
}

function categorySummary(results) {
  const categories = {};
  for (const result of results) {
    const current = categories[result.category] || { total: 0, passed: 0, failed: 0 };
    current.total += 1;
    if (result.passed) current.passed += 1;
    else current.failed += 1;
    categories[result.category] = current;
  }
  return categories;
}

export async function runMemoryEvaluation({
  cases,
  execute,
  includeContext = false,
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(cases)) throw new Error("runMemoryEvaluation 需要 cases 数组。");
  if (typeof execute !== "function") throw new Error("runMemoryEvaluation 需要 execute 函数。");
  const normalizedCases = cases.map((item, index) => (
    isNormalizedEvaluationCase(item) ? item : normalizeEvaluationCase(item, index)
  ));
  const startedAt = now().toISOString();
  const results = [];
  for (const item of normalizedCases) {
    const start = Date.now();
    try {
      const retrieval = await execute(item);
      const result = evaluateRetrievalResult(item, retrieval, { includeContext });
      result.durationMs = Date.now() - start;
      results.push(result);
    } catch (error) {
      results.push({
        id: item.id,
        title: item.title,
        category: item.category,
        query: item.query,
        passed: false,
        durationMs: Date.now() - start,
        assertions: [comparison("execution", false, "successful execution", error.message)],
        actual: { error: error.message },
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  const completedAt = now().toISOString();
  return {
    schemaVersion: 1,
    startedAt,
    completedAt,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? passed / results.length : 1,
      categories: categorySummary(results),
    },
    results,
  };
}

export function writeEvaluationReport(filePath, report) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolved);
  return resolved;
}
