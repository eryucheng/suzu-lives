import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMemoryCandidate,
  DIRECT_INGESTION_MEMORY_KINDS,
  MEMORY_KINDS,
  memoryLayerForKind,
  MemoryRepository,
  normalizeMemoryCandidate,
  openMemoryDatabase,
  resolveMemoryIngestionReview,
} from "../src/index.mjs";

function setup() {
  const database = openMemoryDatabase(":memory:");
  return {
    database,
    repository: new MemoryRepository(database),
  };
}

function explicitFact(overrides = {}) {
  return {
    agentId: "agent-test",
    kind: "fact",
    content: "用户小时候学过围棋。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "biography.learned-go",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "historical",
    confidence: 1,
    ...overrides,
  };
}

test("keeps the user's biography separate from the Agent's biography", () => {
  const { database, repository } = setup();
  const userResult = applyMemoryCandidate(repository, explicitFact());
  const agentResult = applyMemoryCandidate(repository, explicitFact({
    content: "Agent 小时候学过围棋。",
    subjectRole: "agent",
    subjectKey: "agent-test",
  }));

  assert.equal(userResult.status, "created");
  assert.equal(agentResult.status, "created");
  assert.notEqual(userResult.memory.id, agentResult.memory.id);
  assert.equal(
    repository.findCanonicalMemories({
      agentId: "agent-test",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: "biography.learned-go",
    }).length,
    1,
  );
  assert.equal(
    repository.findCanonicalMemories({
      agentId: "agent-test",
      subjectRole: "agent",
      subjectKey: "agent-test",
      canonicalKey: "biography.learned-go",
    }).length,
    1,
  );
  database.close();
});

test("keeps different formal state families separate when canonical keys collide", () => {
  const { database, repository } = setup();
  const identity = applyMemoryCandidate(repository, explicitFact({
    content: "用户把编程视为自己身份的一部分。",
    canonicalKey: "profile.programming",
    representationLayer: "established",
    stateFamily: "identity",
    statePhase: "active",
    temporalState: "current",
  }));
  const capability = applyMemoryCandidate(repository, explicitFact({
    content: "用户能够独立编写 Node.js 脚本。",
    canonicalKey: "profile.programming",
    representationLayer: "established",
    stateFamily: "capability",
    statePhase: "active",
    temporalState: "current",
  }));

  assert.equal(identity.status, "created");
  assert.equal(capability.status, "created");
  assert.notEqual(identity.memory.id, capability.memory.id);
  assert.deepEqual(repository.findCanonicalMemories({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "profile.programming",
    representationLayer: "established",
    stateFamily: "identity",
  }).map((memory) => memory.id), [identity.memory.id]);
  assert.deepEqual(repository.findCanonicalMemories({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "profile.programming",
    representationLayer: "established",
    stateFamily: "capability",
  }).map((memory) => memory.id), [capability.memory.id]);
  database.close();
});

test("reinforces exact duplicates instead of creating another node", () => {
  const { database, repository } = setup();
  const first = applyMemoryCandidate(repository, explicitFact({ confidence: 0.8 }));
  const second = applyMemoryCandidate(repository, explicitFact({
    confidence: 1,
    actorRoles: [{
      role: "participant",
      actorRole: "user",
      actorKey: "user",
      confidence: 1,
      provenance: "test-reinforcement",
    }],
  }));
  assert.equal(first.status, "created");
  assert.equal(second.status, "reinforced");
  assert.equal(second.memory.id, first.memory.id);
  assert.equal(second.memory.confidence, 1);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    1,
  );
  assert.equal(
    repository.getMemoryDetail("agent-test", first.memory.id).roles
      .some((role) => role.role === "participant" && role.actor_role === "user"),
    true,
  );
  database.close();
});

test("requires an explicit change action before replacing a different claim", () => {
  const { database, repository } = setup();
  const first = applyMemoryCandidate(repository, explicitFact());
  const ambiguous = applyMemoryCandidate(repository, explicitFact({
    content: "用户从来没有学过围棋。",
  }));
  assert.equal(first.status, "created");
  assert.equal(ambiguous.status, "review");
  assert.deepEqual(
    ambiguous.reasons,
    ["same-key-different-content-needs-explicit-change"],
  );
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    1,
  );
  database.close();
});

test("preserves the old claim and links an explicit correction", () => {
  const { database, repository } = setup();
  const previous = applyMemoryCandidate(repository, explicitFact()).memory;
  const correction = applyMemoryCandidate(repository, explicitFact({
    content: "用户没有系统学过围棋，只是偶尔下过。",
    revisionAction: "correct",
  }));
  assert.equal(correction.status, "correct");
  assert.equal(repository.getMemory(previous.id).status, "superseded");
  assert.equal(correction.memory.status, "active");
  const edge = database.prepare(`
    SELECT relation FROM memory_edges
    WHERE from_memory_id = ? AND to_memory_id = ?
  `).get(correction.memory.id, previous.id);
  assert.equal(edge.relation, "corrects");
  database.close();
});

test("sends unsupported inferred stateful memories to review", () => {
  const candidate = normalizeMemoryCandidate({
    agentId: "agent-test",
    kind: "preference",
    content: "用户一定喜欢科幻。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "preference.genre.science-fiction",
    reality: "real",
    evidenceMode: "inferred",
    temporalState: "current",
    confidence: 0.99,
  });
  assert.equal(candidate.confidence, 0.65);

  const { database, repository } = setup();
  const result = applyMemoryCandidate(repository, candidate);
  assert.equal(result.status, "review");
  assert.deepEqual(
    result.reasons.sort(),
    ["inferred-stateful-memory", "missing-source-evidence"].sort(),
  );
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    0,
  );
  database.close();
});

test("allows memory policy writes inside a caller-owned transaction", () => {
  const { database, repository } = setup();
  repository.transaction(() => {
    const result = applyMemoryCandidate(repository, explicitFact());
    assert.equal(result.status, "created");
  });
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    1,
  );
  database.close();
});

test("keeps an incompatible state family and node kind out of formal memory", () => {
  const { database, repository } = setup();
  const result = applyMemoryCandidate(repository, explicitFact({
    kind: "belief_state",
    stateFamily: "capability",
    statePhase: "active",
  }));
  assert.equal(result.status, "reject");
  assert.equal(result.reasons.includes("state-family-kind-mismatch"), true);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    0,
  );
  database.close();
});

test("keeps uncertain identity in review instead of forcing an owner", () => {
  const { database, repository } = setup();
  const result = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "event",
    content: "有人去了科技馆，但现有证据无法确定是谁。",
    subjectRole: "unknown",
    subjectKey: "",
    reality: "unknown",
    evidenceMode: "manual",
    temporalState: "unknown",
  });
  assert.equal(result.status, "review");
  assert.deepEqual(
    result.reasons.sort(),
    ["unknown-reality", "unknown-subject", "unknown-temporal-state"].sort(),
  );
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    0,
  );
  database.close();
});

test("stores an explicit belief state with a known time and structured holder", () => {
  const { database, repository } = setup();
  const result = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "belief_state",
    content: "Agent 目前知道并不是所有鱼都难吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "belief.food.fish",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
    revisionAction: "add",
    knownAt: "2026-07-10T12:00:00.000Z",
    validFrom: "2026-07-10T12:00:00.000Z",
    actorRoles: [{
      role: "belief_holder",
      actorRole: "agent",
      actorKey: "agent-test",
      isPrimary: true,
      confidence: 1,
      provenance: "test",
    }],
  });
  assert.equal(result.status, "created");
  assert.equal(result.memory.kind, "belief_state");
  assert.equal(result.memory.known_at, "2026-07-10T12:00:00.000Z");
  assert.equal(result.memory.valid_from, "2026-07-10T12:00:00.000Z");
  assert.equal(
    repository.getMemoryDetail("agent-test", result.memory.id).roles
      .some((role) => role.role === "belief_holder" && role.actor_role === "agent"),
    true,
  );
  assert.equal(memoryLayerForKind("episode"), "episodic");
  assert.equal(memoryLayerForKind("topic"), "semantic");
  assert.equal(memoryLayerForKind("topic_or_episode"), "structural");
  assert.equal(MEMORY_KINDS.includes("episode"), true);
  assert.equal(MEMORY_KINDS.includes("topic"), true);
  assert.equal(DIRECT_INGESTION_MEMORY_KINDS.includes("episode"), false);
  assert.equal(DIRECT_INGESTION_MEMORY_KINDS.includes("topic"), false);
  database.close();
});

test("derives a state holder from the verified primary subject", () => {
  const { database, repository } = setup();
  const result = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "preference",
    content: "用户明确喜欢参观科技展览。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:technology-exhibition",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
  });
  assert.equal(result.status, "created");
  const holders = repository.getMemoryDetail("agent-test", result.memory.id).roles
    .filter((role) => role.role === "preference_holder");
  assert.equal(holders.length, 1);
  assert.equal(holders[0].actor_role, "user");
  assert.equal(holders[0].actor_key, "user");
  assert.equal(holders[0].provenance, "memory-policy-kind-subject");
  database.close();
});

test("rejects malformed and reversed temporal fields instead of erasing them", () => {
  const { database, repository } = setup();
  const invalidDate = applyMemoryCandidate(repository, explicitFact({
    eventDate: "2026-02-30",
  }));
  assert.equal(invalidDate.status, "reject");
  assert.deepEqual(invalidDate.reasons, ["invalid-event-date"]);

  const reversedEvent = applyMemoryCandidate(repository, explicitFact({
    eventStart: "2026-07-02T08:00:00.000Z",
    eventEnd: "2026-07-01T08:00:00.000Z",
  }));
  assert.equal(reversedEvent.status, "reject");
  assert.deepEqual(reversedEvent.reasons, ["event-end-before-event-start"]);

  const reversedValidity = applyMemoryCandidate(repository, explicitFact({
    validFrom: "2026-07-02T08:00:00.000Z",
    validTo: "2026-07-01T08:00:00.000Z",
  }));
  assert.equal(reversedValidity.status, "reject");
  assert.deepEqual(reversedValidity.reasons, ["valid-to-before-valid-from"]);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    0,
  );
  database.close();
});

test("keeps contradictory holder and in-progress end time in review", () => {
  const { database, repository } = setup();
  const holderConflict = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "preference",
    content: "Agent 喜欢科幻。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:preference:science-fiction",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
    actorRoles: [{
      role: "preference_holder",
      actorRole: "user",
      actorKey: "user",
      confidence: 1,
    }],
  });
  assert.equal(holderConflict.status, "review");
  assert.deepEqual(holderConflict.reasons, ["holder-conflicts-with-subject"]);

  const inProgressWithEnd = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "open_loop",
    content: "用户仍在等待检查结果。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:open-loop:medical-result",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "in_progress",
    eventStart: "2026-07-01T08:00:00.000Z",
    eventEnd: "2026-07-01T09:00:00.000Z",
  });
  assert.equal(inProgressWithEnd.status, "review");
  assert.deepEqual(inProgressWithEnd.reasons, ["in-progress-memory-has-event-end"]);
  database.close();
});

test("turns an updated belief into current state while preserving the old belief as history", () => {
  const { database, repository } = setup();
  const key = "agent:belief:food:fish";
  const previous = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "belief_state",
    content: "Agent 觉得鱼很难吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: key,
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
    knownAt: "2026-07-01T08:00:00.000Z",
  });
  assert.equal(previous.status, "created");
  assert.equal(previous.memory.valid_from, "2026-07-01T08:00:00.000Z");

  const current = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "belief_state",
    content: "Agent 现在知道有些鱼很好吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: key,
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
    revisionAction: "update",
    knownAt: "2026-07-10T08:00:00.000Z",
  });
  assert.equal(current.status, "update");
  assert.equal(current.memory.valid_from, "2026-07-10T08:00:00.000Z");
  const old = repository.getMemory(previous.memory.id);
  assert.equal(old.status, "superseded");
  assert.equal(old.valid_to, "2026-07-10T08:00:00.000Z");
  assert.equal(
    repository.getCurrentCanonicalMemory({
      agentId: "agent-test",
      subjectRole: "agent",
      subjectKey: "agent-test",
      canonicalKey: key,
    }).id,
    current.memory.id,
  );
  assert.deepEqual(
    repository.listCanonicalStateHistory({
      agentId: "agent-test",
      subjectRole: "agent",
      subjectKey: "agent-test",
      canonicalKey: key,
    }).map((memory) => memory.id),
    [current.memory.id, previous.memory.id],
  );
  assert.equal(database.prepare(`
    SELECT relation FROM memory_edges
    WHERE from_memory_id = ? AND to_memory_id = ?
  `).get(current.memory.id, previous.memory.id).relation, "supersedes");

  const stale = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "belief_state",
    content: "Agent 在更早时觉得所有鱼都一般。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: key,
    reality: "real",
    evidenceMode: "manual",
    temporalState: "historical",
    revisionAction: "update",
    knownAt: "2026-07-05T08:00:00.000Z",
  });
  assert.equal(stale.status, "review");
  assert.deepEqual(stale.reasons, ["state-change-older-than-current-state"]);
  assert.equal(
    repository.getCurrentCanonicalMemory({
      agentId: "agent-test",
      subjectRole: "agent",
      subjectKey: "agent-test",
      canonicalKey: key,
    }).id,
    current.memory.id,
  );
  database.close();
});

test("accepts only a corrected pending candidate and preserves both review versions", () => {
  const { database, repository } = setup();
  const pending = repository.recordIngestionDecision({
    agentId: "agent-test",
    batchId: "batch-review-1",
    candidateIndex: 0,
    decision: "review",
    resultStatus: "review",
    reasonCodes: ["unknown-subject"],
    candidate: {
      kind: "fact",
      content: "有人小时候学过围棋。",
      subjectRole: "unknown",
    },
    knownAt: "2026-07-01T08:00:00.000Z",
  });
  const accepted = resolveMemoryIngestionReview(repository, {
    agentId: "agent-test",
    decisionId: pending.id,
    action: "accept",
    candidate: explicitFact({
      actorRoles: [{
        role: "experiencer",
        actorRole: "user",
        actorKey: "user",
        confidence: 1,
        provenance: "human-review",
      }],
    }),
    note: "已根据原话确认主体是用户。",
    resolvedBy: "owner",
    recordedAt: "2026-07-02T09:00:00.000Z",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.memory.known_at, "2026-07-01T08:00:00.000Z");
  assert.equal(accepted.memory.recorded_at, "2026-07-02T09:00:00.000Z");
  assert.equal(accepted.memory.evidence_mode, "manual");
  assert.equal(accepted.decision.review_state, "accepted");
  assert.equal(accepted.decision.resolved_by, "owner");
  assert.equal(accepted.decision.candidate.subjectRole, "unknown");
  assert.equal(accepted.decision.resolvedCandidate.subjectRole, "user");
  assert.equal(accepted.decision.memory_id, accepted.memory.id);
  assert.throws(
    () => resolveMemoryIngestionReview(repository, {
      agentId: "agent-test",
      decisionId: pending.id,
      action: "dismiss",
    }),
    /already accepted/u,
  );
  database.close();
});

test("keeps an invalid correction pending and can later dismiss it", () => {
  const { database, repository } = setup();
  const pending = repository.recordIngestionDecision({
    agentId: "agent-test",
    batchId: "batch-review-2",
    candidateIndex: 0,
    decision: "review",
    resultStatus: "review",
    reasonCodes: ["unknown-subject"],
    candidate: { kind: "event", content: "主体未知的事件。" },
  });
  const invalid = resolveMemoryIngestionReview(repository, {
    agentId: "agent-test",
    decisionId: pending.id,
    action: "accept",
    candidate: {
      kind: "event",
      content: "主体仍然未知的事件。",
      subjectRole: "unknown",
      reality: "unknown",
      temporalState: "unknown",
    },
  });
  assert.equal(invalid.status, "needs-correction");
  assert.equal(invalid.decision.review_state, "pending");
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    0,
  );
  const dismissed = resolveMemoryIngestionReview(repository, {
    agentId: "agent-test",
    decisionId: pending.id,
    action: "dismiss",
    note: "证据不足，不进入长期记忆。",
  });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.decision.review_state, "dismissed");
  assert.equal(dismissed.decision.memory_id, null);
  assert.equal(dismissed.decision.resolution_note, "证据不足，不进入长期记忆。");
  database.close();
});
