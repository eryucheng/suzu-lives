import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import {
  evaluateAffectiveAssociationEvidence,
  reviewReportedAffectiveAssociationState,
} from "../src/index.mjs";

const KEY = "user:affective:science-museum:nostalgia";

function setup({ currentLayer = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (currentLayer) {
    current = repository.upsertMemory({
      id: `current-${currentLayer}-affective`,
      agentId: "agent-test",
      kind: currentLayer === "reported" ? "belief_state" : "derived_hypothesis",
      layer: "semantic",
      content: "科技馆会引起用户的怀念感。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      representationLayer: currentLayer,
      stateFamily: "affective_association",
      statePhase: "active",
      reality: "real",
      evidenceMode: currentLayer === "reported" ? "explicit" : "inferred",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        affectiveClaim: {
          trigger: {
            role: "other",
            key: "place:science-museum",
            type: "place",
            label: "科技馆",
            targetMatch: "exact",
          },
          emotion: { label: "怀念", valence: "positive", intensity: "medium" },
          recurrence: "repeated_claim",
          holderStatementStatus: currentLayer === "reported" ? "directly-reported" : "aggregated",
          crossTimeStability: currentLayer === "reported" ? "unverified" : "supported",
          activationBiasStatus: "disabled",
        },
      },
      actorRoles: [{
        role: "experiencer",
        actorRole: "user",
        actorKey: "user",
        isPrimary: true,
      }],
    });
  }
  return { database, repository, current };
}

function addSourceMemory(fixture, {
  id,
  sourceContent,
  observedAt = "2026-07-10T12:00:00.000Z",
  sourceSpeaker = "User",
  speakerRole = "user",
  speakerKey = "user",
} = {}) {
  const source = fixture.repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    speaker: sourceSpeaker,
    content: sourceContent,
  });
  const memory = fixture.repository.upsertMemory({
    id,
    agentId: "agent-test",
    kind: "event",
    layer: "semantic",
    content: sourceContent,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "current",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [
      { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
      { role: "experiencer", actorRole: "user", actorKey: "user" },
    ],
  });
  fixture.repository.linkSource(memory.id, source.id, "evidence", {
    authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { memory, source };
}

function common(record) {
  return {
    memoryId: record.memory.id,
    sourceIds: [record.source.id],
    confidence: 0.9,
    rationale: "直接来源支持该字段。",
  };
}

function analyzersFor(record, {
  emotionLabel = "怀念",
  valence = "positive",
  intensity = "medium",
  attribution = "explicit_self_report",
  associationType = "explicit_trigger_link",
  causality = "explicit",
  recurrence = "one_off",
  stateTime = "current",
  changeCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
} = {}) {
  return {
    triggerEmotion: async () => ({ output: { analyses: [{
      ...common(record),
      targetMatch: "exact",
      triggerType: "place",
      triggerLabel: "科技馆",
      emotionLabel,
      valence,
      intensity,
    }] } }),
    experiencerAttribution: async () => ({ output: { analyses: [{
      ...common(record),
      experiencerMatch: "yes",
      attribution,
    }] } }),
    associationBasis: async () => ({ output: { analyses: [{
      ...common(record),
      associationType,
      causality,
      recurrence,
    }] } }),
    timeRevision: async () => ({ output: { analyses: [{
      ...common(record),
      stateTime,
      changeCue,
    }] } }),
    currentRelation: async () => ({ output: { analyses: [{
      ...common(record),
      currentStatePresent,
      relation,
      scopeOverlap,
    }] } }),
  };
}

async function evaluate(fixture, record, options = {}, overrides = {}) {
  return evaluateAffectiveAssociationEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    triggerRole: "other",
    triggerKey: "place:science-museum",
    triggerLabel: "科技馆",
    canonicalKey: KEY,
    associationLabel: "科技馆引起的怀念",
    memoryIds: [record.memory.id],
    analyzers: analyzersFor(record, options),
    currentRepresentationLayer: "reported",
    ...overrides,
  });
}

function review(fixture) {
  return reviewReportedAffectiveAssociationState({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    associationLabel: "科技馆引起的怀念",
  });
}

function linkCurrent(fixture, record, relation = "supported_by") {
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: record.memory.id,
    relation,
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
}

test("creates only a reported affective association and keeps activation bias disabled", async () => {
  const fixture = setup();
  const record = addSourceMemory(fixture, {
    id: "direct-affective-report",
    sourceContent: "每次想到科技馆，我都会怀念那次出行。",
  });
  await evaluate(fixture, record, { associationType: "repeated_pattern", recurrence: "repeated_claim" });
  const result = review(fixture);
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.kind, "belief_state");
  assert.equal(result.proposedState.statePhase, "active");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.affectiveClaim.crossTimeStability, "unverified");
  assert.equal(result.proposedState.affectiveClaim.activationBiasStatus, "disabled");
  assert.equal(result.activationBiasAllowed, false);
  assert.equal(result.automaticActivationBiasWriteAllowed, false);
  fixture.database.close();
});

test("does not promote cooccurrence, mood, preference, or model inference into a direct report", async () => {
  const fixture = setup();
  const cases = [
    { id: "cooccurrence", text: "在科技馆时刚好收到坏消息，我那时很难过。",
      options: { emotionLabel: "难过", valence: "negative", associationType: "single_cooccurrence", causality: "none" } },
    { id: "mood", text: "我现在有点难过，刚好又看见科技馆。",
      options: { emotionLabel: "难过", valence: "negative", associationType: "current_mood", causality: "none", stateTime: "temporary" } },
    { id: "preference", text: "我喜欢科技馆。",
      options: { emotionLabel: "喜欢", associationType: "general_preference", causality: "none" } },
    { id: "inference", text: "听语气我觉得科技馆让用户很怀念。",
      options: { attribution: "model_inference" }, sourceSpeaker: "Agent", speakerRole: "agent", speakerKey: "agent-test" },
  ];
  for (const item of cases) {
    const record = addSourceMemory(fixture, {
      id: item.id,
      sourceContent: item.text,
      sourceSpeaker: item.sourceSpeaker,
      speakerRole: item.speakerRole,
      speakerKey: item.speakerKey,
    });
    await evaluate(fixture, record, item.options);
  }
  const result = review(fixture);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticEstablishedAssociationWriteAllowed, false);
  fixture.database.close();
});

test("does not let an established association occupy the reported layer", async () => {
  const fixture = setup({ currentLayer: "established" });
  const record = addSourceMemory(fixture, {
    id: "reported-over-established",
    sourceContent: "想到科技馆时，我会怀念那次出行。",
  });
  await evaluate(fixture, record);
  const result = review(fixture);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(result.snapshot.currentState, null);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("rejects evidence that was not analyzed against the reported layer", async () => {
  const fixture = setup();
  const record = addSourceMemory(fixture, {
    id: "unspecified-layer",
    sourceContent: "想到科技馆时，我会怀念那次出行。",
  });
  await evaluate(fixture, record, {}, { currentRepresentationLayer: "" });
  const result = review(fixture);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-affective-association-report");
  fixture.database.close();
});

test("keeps different direct affective reports unresolved without an explicit change cue", async () => {
  const fixture = setup();
  const first = addSourceMemory(fixture, {
    id: "first-affect",
    sourceContent: "想到科技馆时，我会怀念那次出行。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  const second = addSourceMemory(fixture, {
    id: "second-affect",
    sourceContent: "想到科技馆时，我会感到平静。",
    observedAt: "2026-07-11T12:00:00.000Z",
  });
  await evaluate(fixture, first);
  await evaluate(fixture, second, { emotionLabel: "平静" });
  const result = review(fixture);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("supersedes only the reported layer after an explicit emotion change", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = addSourceMemory(fixture, {
    id: "emotion-change",
    sourceContent: "以前会怀念，现在想到科技馆更多是平静。",
  });
  await evaluate(fixture, record, {
    emotionLabel: "平静",
    changeCue: "emotion_changed",
    currentStatePresent: true,
    relation: "emotion_changed",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.affectiveClaim.emotion.label, "平静");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  assert.equal(result.truthBoundary.establishedAssociationIsUnaffected, true);
  fixture.database.close();
});

test("supersedes a reported intensity only with the matching explicit cue", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = addSourceMemory(fixture, {
    id: "stronger-affect",
    sourceContent: "现在想到科技馆时，怀念的感觉比以前更强了。",
  });
  await evaluate(fixture, record, {
    intensity: "high",
    changeCue: "strengthened",
    currentStatePresent: true,
    relation: "intensity_up",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.affectiveClaim.emotion.intensity, "high");
  fixture.database.close();
});

test("retires only the reported association after an explicit same-scope extinction", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = addSourceMemory(fixture, {
    id: "extinguished-affect",
    sourceContent: "现在再想到科技馆已经不会怀念了。",
  });
  await evaluate(fixture, record, {
    changeCue: "extinguished",
    currentStatePresent: true,
    relation: "retires",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "retire");
  assert.equal(result.proposedState, null);
  assert.equal(result.activationBiasAllowed, false);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("corrects only a denied reported attribution and does not create a replacement state", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = addSourceMemory(fixture, {
    id: "denied-affect",
    sourceContent: "我从来没说过科技馆会让我怀念，那不是我的感受。",
  });
  await evaluate(fixture, record, {
    changeCue: "denies_prior_state",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "correct_attribution");
  assert.equal(result.proposedState, null);
  assert.equal(result.automaticStateWriteAllowed, false);
  fixture.database.close();
});
