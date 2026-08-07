import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  buildSubjectAttributionSnapshot,
  openMemoryDatabase,
  proposeMemorySubjectAttribution,
  resolveMemorySubjectAttribution,
} from "../src/index.mjs";

function fixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "legacy-message-1",
    occurredAt: "2026-07-04T02:00:00.000Z",
    speaker: "User",
    content: "我今天去了科技馆，还看了机器人展。",
  });
  const memory = repository.upsertMemory({
    id: "legacy-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "2026年7月4日，用户去了科技馆并看了机器人展。",
    subjectRole: "unknown",
    evidenceMode: "imported",
    eventDate: "2026-07-04",
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "legacy_unknown",
    provenance: "test",
  });
  const allowedActors = [
    { role: "user", key: "user", name: "用户" },
    { role: "agent", key: "agent-test", name: "Agent" },
  ];
  return { database, repository, source, memory, allowedActors };
}

function candidate(sourceId) {
  return {
    subjectRole: "user",
    subjectKey: "user",
    sourceIds: [sourceId],
    actorRoles: [{
      role: "experiencer",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
      confidence: 0.98,
      sourceIds: [sourceId],
    }],
    confidence: 0.96,
    rationale: "来源中用户以第一人称明确陈述自己去了科技馆。",
  };
}

test("keeps legacy subject attribution pending until a human accepts it", () => {
  const { database, repository, source, memory, allowedActors } = fixture();
  const snapshot = buildSubjectAttributionSnapshot({
    repository,
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
  });
  assert.equal(snapshot.memory.subjectRole, "unknown");
  assert.equal(snapshot.inputPolicy.speakerIsNotAutomaticallySubject, true);

  const proposal = proposeMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    candidate: candidate(source.id),
  });
  assert.equal(proposal.review_state, "pending");
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");

  const accepted = resolveMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
    resolvedBy: "reviewer",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.memory.subject_role, "user");
  assert.equal(accepted.memory.subject_key, "user");
  assert.equal(
    repository.listMemoryRoles(memory.id).some((role) => (
      role.role === "experiencer"
      && role.actor_role === "user"
      && role.actor_key === "user"
    )),
    true,
  );
  assert.equal(repository.getMemoryDetail("agent-test", memory.id).mutations.length, 1);
  database.close();
});

test("rejects actor and source IDs outside the bounded attribution snapshot", () => {
  const { database, repository, source, memory, allowedActors } = fixture();
  assert.throws(() => proposeMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    candidate: {
      ...candidate(source.id),
      subjectRole: "other",
      subjectKey: "invented-person",
    },
  }), /outside allowedActors/u);
  assert.throws(() => proposeMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    candidate: {
      ...candidate(source.id),
      sourceIds: ["outside-source"],
      actorRoles: [],
    },
  }), /linked source evidence/u);
  database.close();
});

test("refuses to apply a proposal after its evidence snapshot changes", () => {
  const { database, repository, source, memory, allowedActors } = fixture();
  const proposal = proposeMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    candidate: candidate(source.id),
  });
  repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "legacy-message-1",
    occurredAt: "2026-07-04T02:00:00.000Z",
    speaker: "User",
    content: "后来修正：我说的是朋友去了科技馆。",
  });
  assert.throws(() => resolveMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /evidence changed/u);
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");
  assert.equal(
    repository.getSubjectAttributionProposal("agent-test", proposal.id).review_state,
    "pending",
  );
  database.close();
});

test("dismisses an attribution proposal without touching the memory", () => {
  const { database, repository, source, memory, allowedActors } = fixture();
  const proposal = proposeMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    candidate: candidate(source.id),
  });
  const dismissed = resolveMemorySubjectAttribution(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "dismiss",
    note: "Evidence is ambiguous.",
  });
  assert.equal(dismissed.proposal.review_state, "dismissed");
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");
  database.close();
});
