import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { evaluateCapabilityEvidence } from "../src/index.mjs";

const KEY = "user:capability:node-scripting";

function setup({ withCurrent = false, currentRepresentationLayer = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({
    id, content, sourceContent, sourceSpeaker = "User", speakerRole = "user",
    speakerKey = "user", evidenceMode = "explicit",
    occurredAt = "2026-07-10T12:00:00.000Z",
  }) => {
    const source = repository.upsertSource({
      agentId: "agent-test", sourceKind: "conversation", externalId: `source-${id}`,
      occurredAt, speaker: sourceSpeaker, content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id, agentId: "agent-test", kind: "event", layer: "semantic", content,
      subjectRole: "user", subjectKey: "user", reality: "real", evidenceMode,
      temporalState: "current", eventStart: occurredAt, knownAt: occurredAt,
      actorRoles: [
        { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
        { role: "experiencer", actorRole: "user", actorKey: "user" },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: evidenceMode === "observed" ? "direct_observation"
        : speakerRole === "user" ? "subject_firsthand" : "model_inference",
      sourceTrust: 0.95, evidenceStrength: 1, provenance: "test",
    });
    return { memory, source };
  };
  let current = null;
  if (withCurrent) {
    const source = repository.upsertSource({
      agentId: "agent-test", sourceKind: "conversation", externalId: "source-current-node-capability",
      occurredAt: "2026-07-01T08:00:00.000Z", speaker: "User",
      content: "我能独立编写和调试常见 Node.js 脚本。",
    });
    const memory = repository.upsertMemory({
      id: "current-node-capability", agentId: "agent-test", kind: "fact", layer: "semantic",
      content: "用户能独立编写和调试常见 Node.js 脚本。",
      subjectRole: "user", subjectKey: "user", canonicalKey: KEY,
      stateFamily: "capability", statePhase: "active",
      reality: "real", evidenceMode: "explicit", representationLayer: currentRepresentationLayer,
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z", validFrom: "2026-07-01T08:00:00.000Z",
      actorRoles: [{ role: "subject", actorRole: "user", actorKey: "user", isPrimary: true }],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: "subject_firsthand", sourceTrust: 0.95, evidenceStrength: 1, provenance: "test",
    });
    current = { memory, source };
  }
  return { database, repository, add, current };
}

function common(record) {
  return { memoryId: record.memory.id, sourceIds: [record.source.id], confidence: 0.9,
    rationale: "直接来源支持该字段。" };
}

function analyzersFor(record, {
  targetMatch = "exact", skillLabel = "Node.js 脚本", scopeLabel = "编写常见 Node.js 脚本",
  taskDifficulty = "intermediate", holderMatch = "yes", attribution = "explicit_self_statement",
  evidenceType = "self_report", outcome = "no_result", proficiencyClaim = "competent",
  failureCause = "not_applicable", independence = "not_applicable", dependencyLabel = "",
  repeatability = "not_applicable", conditionLabel = "", stateTime = "current",
  changeCue = "none", currentStatePresent = false, relation = "no_current_state",
  scopeOverlap = "none",
} = {}) {
  return {
    skillGrounding: async () => ({ output: { analyses: [{
      ...common(record), targetMatch, skillLabel, scopeLabel, taskDifficulty,
    }] } }),
    holderAttribution: async () => ({ output: { analyses: [{
      ...common(record), holderMatch, attribution,
    }] } }),
    performanceEvidence: async () => ({ output: { analyses: [{
      ...common(record), evidenceType, outcome, proficiencyClaim, failureCause,
    }] } }),
    independenceConditions: async () => ({ output: { analyses: [{
      ...common(record), independence, dependencyLabel, repeatability, conditionLabel,
    }] } }),
    timeCurrentRelation: async () => ({ output: { analyses: [{
      ...common(record), stateTime, changeCue, currentStatePresent, relation, scopeOverlap,
    }] } }),
  };
}

function evaluate(fixture, record, analyzers, overrides = {}) {
  return evaluateCapabilityEvidence({
    repository: fixture.repository, agentId: "agent-test", subjectRole: "user", subjectKey: "user",
    canonicalKey: KEY, capabilityLabel: "编写 Node.js 脚本", memoryIds: [record.memory.id],
    analyzers, ...overrides,
  });
}

test("keeps a direct capability claim as evidence without creating stable proficiency", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "self-report", content: "用户说自己会写 Node.js 脚本。",
    sourceContent: "我会写 Node.js 脚本。" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "capability_claim");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  assert.notEqual(result.actionPreviews[0].action, "create");
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("keeps one directly observed success scoped and non-stable", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "observed-success", content: "用户成功编写并运行一个 Node.js 清理脚本。",
    sourceContent: "脚本运行成功并输出预期结果。", sourceSpeaker: "Tool", speakerRole: "other",
    speakerKey: "tool", evidenceMode: "observed" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    attribution: "direct_observation", evidenceType: "demonstrated_result", outcome: "success",
    proficiencyClaim: "none", independence: "independent", repeatability: "one_off",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].scope.repeatability, "one_off");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  assert.notEqual(result.actionPreviews[0].action, "reinforce");
  fixture.database.close();
});

test("does not turn tool availability or interest into capability", async () => {
  const toolFixture = setup();
  const tool = toolFixture.add({ id: "tool-installed", content: "用户电脑安装了 Node.js。",
    sourceContent: "Node.js 已安装。" });
  const toolResult = await evaluate(toolFixture, tool, analyzersFor(tool, {
    evidenceType: "tool_availability", outcome: "no_result", proficiencyClaim: "none",
  }));
  assert.equal(toolResult.observations[0].qualification, "excluded");
  toolFixture.database.close();

  const interestFixture = setup();
  const interest = interestFixture.add({ id: "coding-interest", content: "用户喜欢看编程内容。",
    sourceContent: "我挺喜欢看编程内容。" });
  const interestResult = await evaluate(interestFixture, interest, analyzersFor(interest, {
    evidenceType: "interest_only", outcome: "no_result", proficiencyClaim: "none",
  }));
  assert.equal(interestResult.observations[0].qualification, "excluded");
  interestFixture.database.close();
});

test("preserves tool dependence on a successful result", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "tool-assisted-success",
    content: "用户借助代码生成工具完成并验证了一个 Node.js 脚本。",
    sourceContent: "我借助代码生成工具写完了，运行验证也通过。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    evidenceType: "demonstrated_result", outcome: "success", proficiencyClaim: "none",
    independence: "tool_dependent", dependencyLabel: "代码生成工具", repeatability: "one_off",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "capability_assisted_result");
  assert.equal(result.observations[0].scope.dependencyLabel, "代码生成工具");
  fixture.database.close();
});

test("does not treat an environment or tool failure as a skill deficit", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({ id: "tool-failure", content: "脚本因为 Node.js 环境损坏而失败。",
    sourceContent: "代码没报逻辑错误，是 Node.js 环境启动不了。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    evidenceType: "failed_attempt", outcome: "failure", proficiencyClaim: "none",
    failureCause: "environment", currentStatePresent: true, relation: "proficiency_down",
    scopeOverlap: "exact", changeCue: "none",
  }));
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.observations[0].excluded_reason, "failure-does-not-demonstrate-a-skill-gap");
  fixture.database.close();
});

test("keeps one same-scope skill-gap failure as review, not an automatic downgrade", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({ id: "skill-gap-failure", content: "用户因不理解异步控制而未能完成脚本。",
    sourceContent: "这次失败是我确实还不会处理这段异步逻辑。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    evidenceType: "failed_attempt", outcome: "failure", proficiencyClaim: "none",
    failureCause: "skill_gap", currentStatePresent: true, relation: "proficiency_down",
    scopeOverlap: "exact", changeCue: "none",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "capability_skill_gap_counter");
  assert.equal(result.actionPreviews[0].action, "review_required");
  assert.notEqual(result.actionPreviews[0].action, "retire");
  fixture.database.close();
});

test("retires only an explicitly lost current capability in the same scope", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({ id: "capability-lost", content: "用户明确说自己现在已经不会维护 Node.js 脚本。",
    sourceContent: "太久没用了，我现在已经不会维护这种 Node.js 脚本了。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    evidenceType: "self_report", outcome: "failure", proficiencyClaim: "none",
    stateTime: "current", changeCue: "lost", currentStatePresent: true,
    relation: "retires", scopeOverlap: "exact",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "retire");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("does not turn the Agent's praise into the user's capability", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "agent-capability-inference", content: "Agent 推测用户很擅长 Node.js。",
    sourceContent: "我觉得用户应该很擅长 Node.js。", sourceSpeaker: "Agent",
    speakerRole: "agent", speakerKey: "agent-test" });
  const result = await evaluate(fixture, record, analyzersFor(record, { attribution: "model_inference" }));
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(result.observations[0].excluded_reason, "capability-is-not-direct-self-report-or-observation");
  fixture.database.close();
});

test("keeps a provider failure as audit only and writes no merged capability evidence", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "capability-provider-failure", content: "用户说自己会写脚本。",
    sourceContent: "我会写这种脚本。" });
  const analyzers = analyzersFor(record);
  analyzers.performanceEvidence = async () => { throw new Error("provider unavailable"); };
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["performanceEvidence"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("rejects a current-state comparison that invents an absent capability", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "invented-current-capability", content: "用户说自己会写脚本。",
    sourceContent: "我会写这种脚本。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    currentStatePresent: true, relation: "supports", scopeOverlap: "exact",
  }));
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["timeCurrentRelation"]);
  fixture.database.close();
});

test("compares a reported capability only against the reported current layer", async () => {
  const fixture = setup({ withCurrent: true, currentRepresentationLayer: "established" });
  const record = fixture.add({ id: "reported-layer-capability", content: "用户说自己会写脚本。",
    sourceContent: "我会写这种脚本。" });
  const result = await evaluate(fixture, record, analyzersFor(record), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState, null);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});
