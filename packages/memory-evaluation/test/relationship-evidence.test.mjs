import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_USER_AGENT_DM_TOPOLOGY,
  buildArchivedUtteranceIdentity,
} from "@suzu-lives/memory-compactor";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { evaluateRelationshipEvidence } from "../src/index.mjs";

const TRUST_KEY = "user:relationship:agent-test:trust";
const LOCATION_PERMISSION_KEY = "user:relationship:agent-test:permission-location";

function setup({ currentKey = "", currentContent = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({
    id,
    content,
    sourceContent,
    sourceSpeaker = "User",
    speakerRole = "user",
    speakerKey = "user",
    subjectRole = "user",
    subjectKey = "user",
    actorRoles = null,
    occurredAt = "2026-07-10T12:00:00.000Z",
  }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt,
      speaker: sourceSpeaker,
      content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "semantic",
      content,
      subjectRole,
      subjectKey,
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      eventStart: occurredAt,
      knownAt: occurredAt,
      actorRoles: actorRoles || [
        { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
        { role: "participant", actorRole: "user", actorKey: "user" },
        { role: "participant", actorRole: "agent", actorKey: "agent-test" },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    return { memory, source };
  };

  let current = null;
  if (currentKey) {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-current-${currentKey}`,
      occurredAt: "2026-07-01T08:00:00.000Z",
      speaker: "User",
      content: currentContent,
    });
    const memory = repository.upsertMemory({
      id: `current-${currentKey.replace(/[^a-z0-9]+/giu, "-")}`,
      agentId: "agent-test",
      kind: "relationship",
      layer: "relational",
      content: currentContent,
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: currentKey,
      stateFamily: "relationship",
      statePhase: "active",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      actorRoles: [
        { role: "subject", actorRole: "user", actorKey: "user", isPrimary: true },
        { role: "participant", actorRole: "agent", actorKey: "agent-test" },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: "subject_firsthand",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    current = { memory, source };
  }
  return { database, repository, add, current };
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
  targetMatch = "exact",
  relationType = "trust",
  polarity = "affirms",
  relationLabel = "信任",
  scopeLabel = "",
  conditionLabel = "",
  holderMatch = "yes",
  counterpartMatch = "yes",
  direction = "holder_to_counterpart",
  attribution = "explicit_self_statement",
  stateTime = "current",
  duration = "ongoing",
  revocationCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
} = {}) {
  return {
    relationGrounding: async () => ({ output: { analyses: [{
      ...common(record),
      targetMatch,
      relationType,
      polarity,
      relationLabel,
      scopeLabel,
      conditionLabel,
    }] } }),
    perspectiveDirection: async () => ({ output: { analyses: [{
      ...common(record),
      holderMatch,
      counterpartMatch,
      direction,
      attribution,
    }] } }),
    scopeTime: async () => ({ output: { analyses: [{
      ...common(record),
      stateTime,
      duration,
      revocationCue,
    }] } }),
    currentRelation: async () => ({ output: { analyses: [{
      ...common(record),
      currentStatePresent,
      relation,
      scopeOverlap,
    }] } }),
  };
}

function evaluate(fixture, record, analyzers, {
  canonicalKey = TRUST_KEY,
  relationshipLabel = "用户对 Agent 的信任",
  ...overrides
} = {}) {
  return evaluateRelationshipEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    counterpartRole: "agent",
    counterpartKey: "agent-test",
    counterpartLabel: "Agent",
    canonicalKey,
    relationshipLabel,
    memoryIds: [record.memory.id],
    analyzers,
    ...overrides,
  });
}

test("creates only a shadow relationship action for the holder's direct statement", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "direct-trust",
    content: "用户明确说自己信任 Agent。",
    sourceContent: "我信任你。",
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "create");
  assert.equal(result.actionPreviews[0].proposedKind, "relationship");
  assert.equal(result.actionPreviews[0].automaticStateWriteAllowed, false);
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  fixture.database.close();
});

test("accepts a girlfriend relationship perspective when production DM evidence names the counterpart", async () => {
  const fixture = setup();
  const identity = buildArchivedUtteranceIdentity({
    messageRole: "assistant",
    agentId: "agent-test",
    conversationTopology: DIRECT_USER_AGENT_DM_TOPOLOGY,
  });
  const record = fixture.add({
    id: "assistant-girlfriend-statement",
    content: "Agent 明确说自己是用户的女朋友。",
    sourceContent: "是，我是你女朋友。",
    sourceSpeaker: "Agent",
    speakerRole: "agent",
    speakerKey: "agent-test",
    subjectRole: identity.subjectRole,
    subjectKey: identity.subjectKey,
    actorRoles: identity.actorRoles,
  });
  const result = await evaluate(
    fixture,
    record,
    analyzersFor(record, { relationType: "role", relationLabel: "女朋友" }),
    {
      subjectRole: "agent",
      subjectKey: "agent-test",
      counterpartRole: "user",
      counterpartKey: "user",
      counterpartLabel: "User",
      canonicalKey: "agent-test:relationship:user:girlfriend",
      relationshipLabel: "Agent 对用户的伴侣关系观点",
    },
  );
  assert.equal(result.runs.perspectiveDirection.status, "completed");
  assert.equal(result.observations[0].qualification, "qualified");
  fixture.database.close();
});

test("does not turn the Agent's inference into the user's relationship", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "agent-guesses-trust",
    content: "Agent 推测用户信任自己。",
    sourceContent: "我感觉用户现在应该很信任我。",
    sourceSpeaker: "Agent",
    speakerRole: "agent",
    speakerKey: "agent-test",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    attribution: "agent_inference",
  }));
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(
    result.observations[0].excluded_reason,
    "relationship-is-not-the-holder-direct-expression",
  );
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  fixture.database.close();
});

test("does not treat one side saying we are close as bilateral confirmation", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "single-side-mutual-claim",
    content: "用户说双方关系很亲近。",
    sourceContent: "我们已经很亲密了。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    relationType: "closeness",
    relationLabel: "亲近",
    direction: "mutual_claim",
  }));
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(
    result.observations[0].excluded_reason,
    "single-side-claim-cannot-prove-a-shared-relationship",
  );
  fixture.database.close();
});

test("preserves a permission's exact scope without granting runtime permission", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "location-permission",
    content: "用户允许 Agent 查看自己的位置。",
    sourceContent: "你可以查看我的位置。",
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record, {
    relationType: "permission",
    polarity: "sets",
    relationLabel: "位置查看许可",
    scopeLabel: "查看用户当前位置",
  }), {
    canonicalKey: LOCATION_PERMISSION_KEY,
    relationshipLabel: "用户授予 Agent 的位置查看许可",
  });
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].scope.scopeLabel, "查看用户当前位置");
  assert.equal(result.actionPreviews[0].action, "create");
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  fixture.database.close();
});

test("previews revocation only for an explicit exact-scope withdrawal", async () => {
  const fixture = setup({
    currentKey: LOCATION_PERMISSION_KEY,
    currentContent: "用户允许 Agent 查看自己的位置。",
  });
  const record = fixture.add({
    id: "revoke-location-permission",
    content: "用户明确撤回位置查看许可。",
    sourceContent: "以后不要再看我的位置了。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    relationType: "permission",
    polarity: "withdraws",
    relationLabel: "撤回位置查看许可",
    scopeLabel: "查看用户当前位置",
    duration: "ended",
    revocationCue: "explicit",
    currentStatePresent: true,
    relation: "revokes",
    scopeOverlap: "exact",
  }), {
    canonicalKey: LOCATION_PERMISSION_KEY,
    relationshipLabel: "用户授予 Agent 的位置查看许可",
  });
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "revoke");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("does not let an unrelated partial withdrawal revoke another permission", async () => {
  const fixture = setup({
    currentKey: LOCATION_PERMISSION_KEY,
    currentContent: "用户允许 Agent 查看自己的位置。",
  });
  const record = fixture.add({
    id: "camera-boundary",
    content: "用户不允许 Agent 查看摄像头。",
    sourceContent: "不要看我的摄像头。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    relationType: "permission",
    polarity: "withdraws",
    relationLabel: "摄像头访问限制",
    scopeLabel: "访问摄像头",
    revocationCue: "explicit",
    currentStatePresent: true,
    relation: "unrelated",
    scopeOverlap: "none",
  }), {
    canonicalKey: LOCATION_PERMISSION_KEY,
    relationshipLabel: "用户授予 Agent 的位置查看许可",
  });
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("does not promote one argument or cold interaction into a relationship state", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "one-argument",
    content: "双方发生了一次争吵。",
    sourceContent: "刚才你说得让我很生气。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    targetMatch: "contextual",
    relationType: "closeness",
    polarity: "uncertain",
    relationLabel: "一次争吵",
    stateTime: "temporary",
    duration: "temporary",
  }));
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(
    result.observations[0].excluded_reason,
    "memory-does-not-express-the-fixed-relationship",
  );
  fixture.database.close();
});

test("keeps a provider failure as audit only and writes no merged relationship evidence", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "relationship-provider-failure",
    content: "用户明确说自己信任 Agent。",
    sourceContent: "我信任你。",
  });
  const analyzers = analyzersFor(record);
  analyzers.scopeTime = async () => {
    throw new Error("provider unavailable");
  };
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["scopeTime"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("rejects a current-state comparison that invents an absent relationship", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "invented-current-relationship",
    content: "用户明确说自己信任 Agent。",
    sourceContent: "我信任你。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    currentStatePresent: true,
    relation: "supports",
    scopeOverlap: "exact",
  }));
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["currentRelation"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("explicitly rejects a shared holder until bilateral review exists", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "shared-relationship",
    content: "用户说双方关系亲近。",
    sourceContent: "我们很亲近。",
  });
  await assert.rejects(() => evaluate(fixture, record, analyzersFor(record), {
    subjectRole: "shared",
    subjectKey: "user+agent-test",
  }), /individual fixed holder/u);
  fixture.database.close();
});

test("compares relationship evidence against the explicitly selected representation layer", async () => {
  const fixture = setup();
  fixture.repository.upsertMemory({
    id: "reported-trust-state",
    agentId: "agent-test",
    kind: "relationship",
    layer: "relational",
    content: "用户表示自己信任 Agent。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TRUST_KEY,
    stateFamily: "relationship",
    statePhase: "active",
    reality: "real",
    evidenceMode: "explicit",
    representationLayer: "reported",
    temporalState: "current",
    knownAt: "2026-07-01T08:00:00.000Z",
    validFrom: "2026-07-01T08:00:00.000Z",
  });
  fixture.repository.upsertMemory({
    id: "established-trust-state",
    agentId: "agent-test",
    kind: "relationship",
    layer: "relational",
    content: "独立证据支持该信任关系。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TRUST_KEY,
    stateFamily: "relationship",
    statePhase: "active",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "established",
    temporalState: "current",
    knownAt: "2026-07-20T08:00:00.000Z",
    validFrom: "2026-07-20T08:00:00.000Z",
  });
  const record = fixture.add({
    id: "reported-layer-support",
    content: "用户再次明确说自己信任 Agent。",
    sourceContent: "我还是信任你。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    currentStatePresent: true,
    relation: "supports",
    scopeOverlap: "exact",
  }), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState.id, "reported-trust-state");
  assert.equal(result.snapshot.currentState.representationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});
