import {
  buildPreferenceEvidenceSnapshot,
} from "./preference-snapshot.mjs";
import { isStateAnalysisTargetComplete } from "@suzu-lives/memory-core";
import {
  evaluatePreferenceEvidenceSpecialists,
} from "./preference-specialist-service.mjs";
import {
  PREFERENCE_SPECIALIST_ANALYZERS,
} from "./preference-specialist-contracts.mjs";
import {
  mergePreferenceSpecialistEvidence,
} from "./preference-specialist-merge.mjs";
import {
  reviewReportedPreferenceState,
} from "./reported-preference-review.mjs";
import {
  proposeReportedStateFromReview,
} from "./reported-state-persistence.mjs";
import { evaluateGoalEvidence } from "./goal-service.mjs";
import { GOAL_ANALYZERS } from "./goal-contracts.mjs";
import { reviewReportedGoalState } from "./reported-goal-review.mjs";
import { evaluateValueEvidence } from "./value-service.mjs";
import { VALUE_ANALYZERS } from "./value-contracts.mjs";
import { reviewReportedValueState } from "./reported-value-review.mjs";
import { evaluateCapabilityEvidence } from "./capability-service.mjs";
import { CAPABILITY_ANALYZERS } from "./capability-contracts.mjs";
import { reviewReportedCapabilityState } from "./reported-capability-review.mjs";
import { evaluateSelfConceptEvidence } from "./self-concept-service.mjs";
import { SELF_CONCEPT_ANALYZERS } from "./self-concept-contracts.mjs";
import { reviewReportedSelfConceptState } from "./reported-self-concept-review.mjs";
import { evaluateBehaviorStateEvidence } from "./behavior-state-service.mjs";
import { BEHAVIOR_STATE_ANALYZERS } from "./behavior-state-contracts.mjs";
import { reviewReportedConditionState } from "./reported-condition-review.mjs";
import { reviewReportedHabitState } from "./reported-habit-review.mjs";
import { reviewReportedDispositionState } from "./reported-disposition-review.mjs";
import { evaluateIdentityEvidence } from "./identity-service.mjs";
import { IDENTITY_ANALYZERS } from "./identity-contracts.mjs";
import { reviewReportedIdentityState } from "./reported-identity-review.mjs";
import { evaluateBeliefEvidence } from "./belief-service.mjs";
import { BELIEF_ANALYZERS } from "./belief-contracts.mjs";
import { reviewReportedBeliefState } from "./reported-belief-review.mjs";
import { evaluateRelationshipEvidence } from "./relationship-service.mjs";
import { RELATIONSHIP_ANALYZERS } from "./relationship-contracts.mjs";
import { reviewReportedRelationshipState } from "./reported-relationship-review.mjs";
import { evaluateAffectiveAssociationEvidence } from "./affective-association-service.mjs";
import { AFFECTIVE_ASSOCIATION_ANALYZERS } from "./affective-association-contracts.mjs";
import { reviewReportedAffectiveAssociationState } from "./reported-affective-association-review.mjs";

export const STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION = "state-analysis-request-v3";
export const REPORTED_PREFERENCE_REVIEW_VERSION = "reported-preference-review-v1";
export const REPORTED_STATE_REQUEST_REVIEW_VERSIONS = Object.freeze({
  preference: REPORTED_PREFERENCE_REVIEW_VERSION,
  goal: "reported-goal-review-v1",
  value: "reported-value-review-v1",
  capability: "reported-capability-review-v1",
  self_concept: "reported-self-concept-review-v1",
  condition: "reported-condition-review-v1",
  habit: "reported-habit-review-v1",
  disposition: "reported-disposition-review-v1",
  identity: "reported-identity-review-v1",
  belief: "reported-belief-review-v1",
  relationship: "reported-relationship-review-v1",
  affective_association: "reported-affective-association-review-v1",
});

function clean(value) {
  return String(value ?? "").trim();
}

function exactSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean));
}

function sameMembers(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function supportedRequest(request) {
  return Boolean(REPORTED_STATE_REQUEST_REVIEW_VERSIONS[request?.state_family])
    && request?.representation_layer === "reported"
    && request.evidence_mode === "explicit"
    && isStateAnalysisTargetComplete(request.state_family, request.targetSpec);
}

function requestAnalyzers(definitions, generator, request) {
  return Object.fromEntries(Object.keys(definitions).map((key) => [
    key,
    (input) => generator({
      ...input,
      stateAnalysisRequestId: request.id,
      stateAnalysisProcessorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
    }),
  ]));
}

function commonEvaluationInput(request, repository, usageLedgerPath, snapshotOptions) {
  return {
    repository,
    agentId: request.agent_id,
    subjectRole: request.subject_role,
    subjectKey: request.subject_key,
    canonicalKey: request.canonical_key,
    memoryIds: request.memoryIds,
    usageLedgerPath,
    snapshotOptions,
  };
}

function subjectLabel(request) {
  return clean(request.metadata?.subjectName) || request.subject_key;
}

function evaluationObservationIds(evaluation, stateFamily) {
  const observations = Array.isArray(evaluation?.observations)
    ? evaluation.observations
    : evaluation?.observations?.[stateFamily] || [];
  return observations.map((observation) => clean(observation?.id)).filter(Boolean);
}

const SIMPLE_REPORTED_REQUEST_ADAPTERS = {
  goal: Object.freeze({
    definitions: GOAL_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateGoalEvidence({
      ...common,
      goalLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedGoalState({
      ...common,
      subjectLabel: subjectLabel(request),
      goalLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  value: Object.freeze({
    definitions: VALUE_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateValueEvidence({
      ...common,
      valueLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedValueState({
      ...common,
      subjectLabel: subjectLabel(request),
      valueLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  capability: Object.freeze({
    definitions: CAPABILITY_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateCapabilityEvidence({
      ...common,
      capabilityLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedCapabilityState({
      ...common,
      subjectLabel: subjectLabel(request),
      capabilityLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  self_concept: Object.freeze({
    definitions: SELF_CONCEPT_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateSelfConceptEvidence({
      ...common,
      selfConceptLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedSelfConceptState({
      ...common,
      subjectLabel: subjectLabel(request),
      selfConceptLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  condition: null,
  habit: null,
  disposition: null,
  identity: Object.freeze({
    definitions: IDENTITY_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateIdentityEvidence({
      ...common,
      identityField: request.targetSpec.identityField,
      identityLabel: request.target_label,
      fieldCardinality: request.targetSpec.fieldCardinality,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedIdentityState({
      ...common,
      subjectLabel: subjectLabel(request),
      identityLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  belief: Object.freeze({
    definitions: BELIEF_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateBeliefEvidence({
      ...common,
      topicLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedBeliefState({
      ...common,
      subjectLabel: subjectLabel(request),
      topicLabel: request.target_label,
      objectRole: request.targetSpec.objectRole,
      objectKey: request.targetSpec.objectKey,
      objectLabel: request.targetSpec.objectLabel,
      snapshotOptions,
    }),
  }),
  relationship: Object.freeze({
    definitions: RELATIONSHIP_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateRelationshipEvidence({
      ...common,
      counterpartRole: request.targetSpec.counterpartRole,
      counterpartKey: request.targetSpec.counterpartKey,
      counterpartLabel: request.targetSpec.counterpartLabel,
      relationshipLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedRelationshipState({
      ...common,
      subjectLabel: subjectLabel(request),
      counterpartRole: request.targetSpec.counterpartRole,
      counterpartKey: request.targetSpec.counterpartKey,
      counterpartLabel: request.targetSpec.counterpartLabel,
      relationshipLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  affective_association: Object.freeze({
    definitions: AFFECTIVE_ASSOCIATION_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateAffectiveAssociationEvidence({
      ...common,
      triggerRole: request.targetSpec.triggerRole,
      triggerKey: request.targetSpec.triggerKey,
      triggerLabel: request.targetSpec.triggerLabel,
      associationLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedAffectiveAssociationState({
      ...common,
      subjectLabel: subjectLabel(request),
      associationLabel: request.target_label,
      snapshotOptions,
    }),
  }),
};

for (const [stateFamily, review] of [
  ["condition", reviewReportedConditionState],
  ["habit", reviewReportedHabitState],
  ["disposition", reviewReportedDispositionState],
]) {
  SIMPLE_REPORTED_REQUEST_ADAPTERS[stateFamily] = Object.freeze({
    definitions: { [stateFamily]: BEHAVIOR_STATE_ANALYZERS[stateFamily] },
    evaluate: (common, analyzers, request) => evaluateBehaviorStateEvidence({
      repository: common.repository,
      agentId: common.agentId,
      subjectRole: common.subjectRole,
      subjectKey: common.subjectKey,
      memoryIds: common.memoryIds,
      usageLedgerPath: common.usageLedgerPath,
      snapshotOptions: common.snapshotOptions,
      targets: {
        [stateFamily]: {
          canonicalKey: request.canonical_key,
          conceptLabel: request.target_label,
          currentRepresentationLayer: "reported",
        },
      },
      analyzers,
    }),
    review: (common, request, snapshotOptions) => review({
      ...common,
      subjectLabel: subjectLabel(request),
      [`${stateFamily}Label`]: request.target_label,
      snapshotOptions,
    }),
  });
}
Object.freeze(SIMPLE_REPORTED_REQUEST_ADAPTERS);

function requestSnapshotOptions(request, snapshotOptions) {
  return {
    ...snapshotOptions,
    allowUtteranceEvidence: true,
    allowedSourceIds: request.sourceIds,
  };
}

function validatePreflight(request, snapshot) {
  const visibleMemoryIds = exactSet(snapshot.memories.map((memory) => memory.id));
  const visibleSourceIds = exactSet(snapshot.sourceRecords.map((source) => source.id));
  if (!sameMembers(visibleMemoryIds, exactSet(request.memoryIds))) {
    return "request-memory-became-ineligible";
  }
  if (!sameMembers(visibleSourceIds, exactSet(request.sourceIds))) {
    return "request-source-boundary-mismatch";
  }
  return "";
}

function blockRequest(repository, request, reason) {
  const resolved = repository.resolveStateAnalysisRequest({
    agentId: request.agent_id,
    requestId: request.id,
    status: "blocked",
    errorMessage: reason,
    metadata: {
      processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
      outcome: "blocked-input",
    },
  });
  return {
    status: "blocked",
    reason,
    request: resolved,
    evaluation: null,
    merged: null,
    review: null,
    proposal: null,
  };
}

export async function processStateAnalysisRequest({
  repository,
  agentId,
  requestId,
  generator,
  usageLedgerPath = "",
  snapshotOptions = {},
  reviewVersion = "",
} = {}) {
  if (!repository) throw new Error("State analysis request processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedRequestId = clean(requestId);
  if (!normalizedAgentId || !normalizedRequestId) {
    throw new Error("State analysis request processing requires agentId and requestId.");
  }
  const request = repository.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId);
  if (!request) throw new Error("State analysis request was not found.");
  if (request.status !== "pending") {
    return {
      status: "already-resolved",
      reason: request.status,
      request,
      evaluation: null,
      merged: null,
      review: null,
      proposal: null,
    };
  }
  if (!supportedRequest(request)) {
    return {
      status: "unsupported",
      reason: `${request.state_family}:${request.representation_layer}`,
      request,
      evaluation: null,
      merged: null,
      review: null,
      proposal: null,
    };
  }
  if (typeof generator !== "function") {
    throw new Error("State analysis request processing requires a generator.");
  }
  if (request.subject_role === "shared") {
    return blockRequest(repository, request, "reported-state-family-requires-individual-subject");
  }

  const boundedSnapshotOptions = requestSnapshotOptions(request, snapshotOptions);
  const preflight = buildPreferenceEvidenceSnapshot({
    repository,
    agentId: normalizedAgentId,
    subjectRole: request.subject_role,
    subjectKey: request.subject_key,
    canonicalKey: request.canonical_key,
    memoryIds: request.memoryIds,
    ...boundedSnapshotOptions,
  });
  const boundaryProblem = validatePreflight(request, preflight);
  if (boundaryProblem) return blockRequest(repository, request, boundaryProblem);

  let evaluation;
  let merged;
  let review;
  if (request.state_family === "preference") {
    const analyzers = requestAnalyzers(PREFERENCE_SPECIALIST_ANALYZERS, generator, request);
    evaluation = await evaluatePreferenceEvidenceSpecialists({
      repository,
      agentId: normalizedAgentId,
      subjectRole: request.subject_role,
      subjectKey: request.subject_key,
      canonicalKey: request.canonical_key,
      objectLabel: request.target_label,
      memoryIds: request.memoryIds,
      analyzers,
      usageLedgerPath,
      snapshotOptions: boundedSnapshotOptions,
    });
    if (evaluation.status !== "incomplete") {
      merged = mergePreferenceSpecialistEvidence(repository, {
        evaluation,
        analysisRequest: request,
      });
      review = reviewReportedPreferenceState({
        repository,
        agentId: normalizedAgentId,
        subjectRole: request.subject_role,
        subjectKey: request.subject_key,
        canonicalKey: request.canonical_key,
        subjectLabel: subjectLabel(request),
        objectLabel: request.target_label,
      });
    }
  } else {
    const adapter = SIMPLE_REPORTED_REQUEST_ADAPTERS[request.state_family];
    const common = commonEvaluationInput(
      request,
      repository,
      usageLedgerPath,
      boundedSnapshotOptions,
    );
    evaluation = await adapter.evaluate(
      common,
      requestAnalyzers(adapter.definitions, generator, request),
      request,
    );
    if (evaluation.status !== "incomplete") {
      const observationIds = evaluationObservationIds(evaluation, request.state_family);
      merged = {
        observations: Array.isArray(evaluation.observations)
          ? evaluation.observations
          : evaluation.observations?.[request.state_family] || [],
        previews: evaluation.actionPreviews || [],
      };
      review = observationIds.length
        ? adapter.review({
          repository,
          agentId: normalizedAgentId,
          subjectRole: request.subject_role,
          subjectKey: request.subject_key,
          canonicalKey: request.canonical_key,
        }, request, {
          ...snapshotOptions,
          analysisRequestId: request.id,
          analysisRequestObservationIds: observationIds,
        })
        : {
          status: "skipped",
          reason: "no-state-evidence-observations",
          representationLayer: "reported",
          automaticStateWriteAllowed: false,
        };
    }
  }
  if (evaluation.status === "incomplete") {
    return {
      status: "retryable-failure",
      reason: evaluation.reason,
      request: repository.getStateAnalysisRequest(normalizedAgentId, request.id),
      evaluation,
      merged: null,
      review: null,
      proposal: null,
    };
  }

  const resolvedReviewVersion = clean(reviewVersion)
    || REPORTED_STATE_REQUEST_REVIEW_VERSIONS[request.state_family];
  const proposalResult = review.status === "ready"
    ? proposeReportedStateFromReview({
      repository,
      reviewResult: review,
      reviewVersion: resolvedReviewVersion,
      batchId: evaluation.batchId,
      metadata: {
        stateAnalysisRequestId: request.id,
        processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
      },
    })
    : { status: "skipped", reason: review.reason, proposal: null };
  const resolved = repository.resolveStateAnalysisRequest({
    agentId: normalizedAgentId,
    requestId: request.id,
    status: "completed",
    analysisBatchId: evaluation.batchId,
    metadata: {
      processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
      outcome: proposalResult.status === "pending" ? "proposal-pending" : "no-proposal",
      reviewStatus: review.status,
      reviewReason: clean(review.reason),
      proposalId: clean(proposalResult.proposal?.id),
    },
  });
  return {
    status: proposalResult.status === "pending" ? "proposal-pending" : "completed-without-proposal",
    reason: clean(proposalResult.reason),
    request: resolved,
    evaluation,
    merged,
    review,
    proposal: proposalResult.proposal,
  };
}

export async function processPendingStateAnalysisRequests({
  repository,
  agentId,
  generator,
  maxRequests,
  usageLedgerPath = "",
  snapshotOptions = {},
  reviewVersion = "",
} = {}) {
  if (!repository) throw new Error("State analysis batch processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedMaximum = Number(maxRequests);
  if (!normalizedAgentId) {
    throw new Error("State analysis batch processing requires agentId.");
  }
  if (!Number.isInteger(normalizedMaximum) || normalizedMaximum < 1 || normalizedMaximum > 500) {
    throw new Error("State analysis batch processing requires maxRequests between 1 and 500.");
  }
  if (typeof generator !== "function") {
    throw new Error("State analysis batch processing requires a generator.");
  }

  const requests = repository.listStateAnalysisRequests(normalizedAgentId, {
    statuses: ["pending"],
    stateFamilies: Object.keys(REPORTED_STATE_REQUEST_REVIEW_VERSIONS),
    representationLayer: "reported",
    evidenceMode: "explicit",
    limit: 500,
  }).filter(supportedRequest).slice(0, normalizedMaximum);
  const results = [];
  for (const request of requests) {
    try {
      results.push(await processStateAnalysisRequest({
        repository,
        agentId: normalizedAgentId,
        requestId: request.id,
        generator,
        usageLedgerPath,
        snapshotOptions,
        reviewVersion,
      }));
    } catch (error) {
      results.push({
        status: "retryable-failure",
        reason: clean(error?.message) || "state-analysis-request-failed",
        request: repository.getStateAnalysisRequest(normalizedAgentId, request.id),
        evaluation: null,
        merged: null,
        review: null,
        proposal: null,
      });
    }
  }

  const counts = Object.fromEntries([
    "proposal-pending",
    "completed-without-proposal",
    "retryable-failure",
    "blocked",
    "already-resolved",
  ].map((status) => [status, results.filter((result) => result.status === status).length]));
  const unsuccessful = counts["retryable-failure"] + counts.blocked;
  return {
    status: results.length === 0
      ? "empty"
      : unsuccessful > 0
        ? "partial-failure"
        : "completed",
    processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
    agentId: normalizedAgentId,
    maxRequests: normalizedMaximum,
    selected: requests.length,
    counts,
    results,
  };
}
