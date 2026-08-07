import { createHash } from "node:crypto";

import {
  MemoryRepository,
  openMemoryDatabase,
  previewEdgePlasticity,
  previewMemoryPlasticity,
} from "@suzu-lives/memory-core";

import { simulatePlasticityTransition } from "./plasticity-simulator.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function hashInput(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function timestamp(value, name) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is not a valid timestamp.`);
  return date.toISOString();
}

function unit(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return number;
}

function elapsedDays(start, end) {
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 86_400_000);
}

function policyVersion(policies) {
  const memory = clean(policies?.memory?.version);
  const edge = clean(policies?.edge?.version);
  if (!memory || !edge) throw new Error("Both memory and edge shadow policies require versions.");
  return `memory:${memory};edge:${edge}`;
}

function asChange(preview, simulation, intentView = "", baseState = null) {
  return {
    targetType: simulation.targetType,
    targetId: simulation.targetId,
    learningTarget: simulation.learningTarget,
    intentView,
    evidenceClass: preview.evidenceClass,
    evidenceTier: preview.evidenceTier,
    candidateDirection: preview.candidateDirection,
    currentValue: simulation.currentValue,
    decayedValue: simulation.decayedValue,
    positiveStep: simulation.positiveStep,
    negativeStep: simulation.negativeStep,
    proposedValue: simulation.proposedValue,
    blocked: simulation.blocked,
    blockReason: simulation.blockReason,
    targetPolicyVersion: simulation.policyVersion,
    baseState: {
      exists: Boolean(baseState),
      value: baseState?.value ?? null,
      policyVersion: baseState?.policy_version || "",
      observationWindowId: baseState?.last_observation_window_id || "",
      appliedAt: baseState?.last_applied_at || null,
    },
    evidence: preview.evidence,
  };
}

export function runPlasticityShadow({
  databasePath,
  agentId,
  observationWindowId,
  windowStart,
  windowEnd,
  policies,
  initialMemoryAccessibility,
  initialEdgeRelationUtility,
  metadata = {},
  createdAt = "",
} = {}) {
  const normalizedAgentId = clean(agentId);
  const normalizedWindowId = clean(observationWindowId);
  if (!clean(databasePath) || !normalizedAgentId || !normalizedWindowId) {
    throw new Error("Plasticity shadow requires databasePath, agentId, and observationWindowId.");
  }
  const start = timestamp(windowStart, "windowStart");
  const end = timestamp(windowEnd, "windowEnd");
  if (start >= end) throw new Error("windowStart must be before windowEnd.");
  const runCreatedAt = createdAt
    ? timestamp(createdAt, "createdAt")
    : new Date().toISOString();
  if (runCreatedAt < end) {
    throw new Error("Plasticity shadow requires an observation window that has already closed.");
  }
  const combinedPolicyVersion = policyVersion(policies);
  const memoryInitial = unit(initialMemoryAccessibility, "initialMemoryAccessibility");
  const edgeInitial = unit(initialEdgeRelationUtility, "initialEdgeRelationUtility");
  const database = openMemoryDatabase(databasePath);
  try {
    const repository = new MemoryRepository(database);
    const memoryStats = repository.listMemoryRetrievalStats(normalizedAgentId, {
      windowStart: start,
      windowEnd: end,
      limit: 500,
      requireComplete: true,
    });
    const edgeStats = repository.listEdgeRetrievalStatsByView(normalizedAgentId, {
      windowStart: start,
      windowEnd: end,
      limit: 2000,
      requireComplete: true,
    });
    const memoryPreviews = memoryStats.map(previewMemoryPlasticity);
    const edgePreviews = edgeStats.map(previewEdgePlasticity);
    const changes = [];
    for (const preview of memoryPreviews) {
      const state = repository.getMemoryAccessibilityState(normalizedAgentId, preview.targetId);
      const currentValue = state?.value ?? memoryInitial;
      const decayStart = state?.last_applied_at
        ? timestamp(state.last_applied_at, "memory state last_applied_at")
        : start;
      const simulation = simulatePlasticityTransition({
        currentValue,
        preview,
        elapsedDays: elapsedDays(decayStart, end),
        observationWindowId: normalizedWindowId,
        policy: policies.memory,
      });
      changes.push(asChange(preview, simulation, "", state));
    }
    for (const preview of edgePreviews) {
      const state = repository.getEdgeRelationUtilityState(
        normalizedAgentId,
        preview.targetId,
        preview.intentView,
      );
      const currentValue = state?.value ?? edgeInitial;
      const decayStart = state?.last_applied_at
        ? timestamp(state.last_applied_at, "edge state last_applied_at")
        : start;
      const simulation = simulatePlasticityTransition({
        currentValue,
        preview,
        elapsedDays: elapsedDays(decayStart, end),
        observationWindowId: normalizedWindowId,
        policy: policies.edge,
      });
      changes.push(asChange(preview, simulation, preview.intentView, state));
    }
    const input = {
      agentId: normalizedAgentId,
      observationWindowId: normalizedWindowId,
      windowStart: start,
      windowEnd: end,
      policies,
      initialMemoryAccessibility: memoryInitial,
      initialEdgeRelationUtility: edgeInitial,
      memoryStats,
      edgeStats,
    };
    const run = repository.recordPlasticityShadowRun({
      agentId: normalizedAgentId,
      policyVersion: combinedPolicyVersion,
      observationWindowId: normalizedWindowId,
      windowStart: start,
      windowEnd: end,
      inputHash: hashInput(input),
      changes,
      metadata: {
        ...metadata,
        runner: "memory-evaluation-plasticity-shadow-v1",
        automaticAdjustmentAllowed: false,
      },
      createdAt: runCreatedAt,
    });
    return {
      ...run,
      automaticAdjustmentAllowed: false,
    };
  } finally {
    database.close();
  }
}
