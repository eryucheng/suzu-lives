import { createHash } from "node:crypto";

import {
  MEMORY_STATE_FAMILIES,
  REPORTED_STATE_PROPOSAL_ACTIONS,
} from "@suzu-lives/memory-core";

function clean(value) {
  return String(value ?? "").trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function proposeReportedStateFromReview({
  repository,
  reviewResult,
  reviewVersion,
  batchId = "",
  metadata = {},
} = {}) {
  if (!repository) throw new Error("Reported state persistence requires a repository.");
  if (!reviewResult || typeof reviewResult !== "object") {
    throw new Error("Reported state persistence requires one review result.");
  }
  if (reviewResult.status !== "ready") {
    return {
      status: "skipped",
      reason: clean(reviewResult.reason) || `review-status-${clean(reviewResult.status) || "unknown"}`,
      proposal: null,
    };
  }
  if (reviewResult.automaticStateWriteAllowed !== false) {
    throw new Error("Reported state review must explicitly forbid automatic state writes.");
  }
  const snapshot = reviewResult.snapshot;
  const target = snapshot?.target;
  const stateFamily = clean(target?.stateFamily);
  const representationLayer = clean(reviewResult.representationLayer);
  const targetLayer = clean(target?.currentRepresentationLayer);
  const action = clean(reviewResult.action);
  if (!snapshot || !MEMORY_STATE_FAMILIES.includes(stateFamily)
    || representationLayer !== "reported" || targetLayer !== "reported"
    || !REPORTED_STATE_PROPOSAL_ACTIONS.includes(action)) {
    throw new Error("Reported state review target, layer, or action is invalid.");
  }
  const currentStateId = clean(reviewResult.currentStateId);
  const snapshotCurrentStateId = clean(snapshot.currentState?.id);
  if (currentStateId !== snapshotCurrentStateId) {
    throw new Error("Reported state review current state does not match its snapshot.");
  }
  const selectedObservationId = clean(reviewResult.selectedObservationId);
  const consideredObservationIds = [...new Set(
    (Array.isArray(reviewResult.consideredObservationIds)
      ? reviewResult.consideredObservationIds
      : []).map(clean).filter(Boolean),
  )];
  if (!selectedObservationId || !consideredObservationIds.includes(selectedObservationId)) {
    throw new Error("Reported state review does not preserve its selected evidence observation.");
  }
  const normalizedReviewVersion = clean(reviewVersion);
  if (!normalizedReviewVersion) throw new Error("Reported state review version is required.");
  const inputHash = hash({
    reviewVersion: normalizedReviewVersion,
    status: reviewResult.status,
    representationLayer,
    action,
    currentStateId,
    proposedState: reviewResult.proposedState || null,
    selectedObservationId,
    consideredObservationIds,
    snapshot,
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: snapshot.agentId,
    batchId,
    stateFamily,
    subjectRole: target.subjectRole,
    subjectKey: target.subjectKey,
    canonicalKey: target.canonicalKey,
    action,
    previousMemoryId: currentStateId || null,
    proposedState: reviewResult.proposedState || null,
    reviewVersion: normalizedReviewVersion,
    inputHash,
    selectedObservationId,
    consideredObservationIds,
    metadata: {
      ...metadata,
      target: {
        subjectLabel: clean(target.subjectLabel),
        stateLabel: clean(target.stateLabel),
      },
      truthBoundary: reviewResult.truthBoundary || {},
    },
  });
  return {
    status: "pending",
    reason: "",
    proposal,
  };
}
