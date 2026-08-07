import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";
import {
  createBrainSnapshot,
  nodeVisualProfile,
  relationVisualFamily,
} from "../src/index.mjs";

test("builds a stable structured-memory brain snapshot without raw utterances", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-brain-layout-"));
  const cachePath = path.join(root, "brain-layout.json");
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "event-a",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "第一次见面",
    content: "第一次见面的事情。",
    eventDate: "2026-07-01",
  });
  repository.upsertMemory({
    id: "event-b",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "后来继续聊天",
    content: "后来继续聊了很久。",
    eventDate: "2026-07-02",
  });
  repository.upsertMemory({
    id: "utterance-a",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "原始对话不应常驻大脑视图。",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-a",
    toMemoryId: "event-b",
    relation: "timeline_next",
    weight: 0.9,
  });
  const first = createBrainSnapshot({
    repository,
    agentId: "agent-test",
    cachePath,
  });
  assert.deepEqual(first.nodes.map((node) => node.id), ["event-a", "event-b"]);
  assert.equal(first.edges.length, 1);
  assert.equal(first.nodes[0].visualTier, "minor");
  assert.deepEqual(first.counts, {
    nodes: 2,
    edges: 1,
    major: 0,
    state: 0,
    minor: 2,
  });
  assert.equal(first.layout.created, 2);
  assert.equal(fs.existsSync(cachePath), true);
  const originalPosition = first.nodes[0].position;

  repository.upsertMemory({
    id: "event-c",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "新的关联事件",
    content: "新事件靠近已有的相关节点。",
    eventDate: "2026-07-03",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-b",
    toMemoryId: "event-c",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  const second = createBrainSnapshot({
    repository,
    agentId: "agent-test",
    cachePath,
  });
  assert.equal(second.layout.reused, 2);
  assert.equal(second.layout.created, 1);
  assert.deepEqual(second.nodes.find((node) => node.id === "event-a").position, originalPosition);
  for (const node of second.nodes) {
    assert.equal(Number.isFinite(node.position.x), true);
    assert.equal(Number.isFinite(node.position.y), true);
    assert.equal(Number.isFinite(node.position.z), true);
  }
  database.close();
});

test("renders formal big neurons, state nodes, overlapping memberships, and all real edge families", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-brain-semantics-"));
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const event = repository.upsertMemory({
    id: "event-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "参观科技馆",
    content: "用户参观了科技馆。",
    eventStart: "2026-07-11T03:00:00.000Z",
  });
  const episode = repository.upsertEpisode({
    id: "episode-weekend",
    agentId: "agent-test",
    title: "周末出行",
    content: "同一次周末出行中的连续经历。",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
  });
  const topic = repository.upsertTopic({
    id: "topic-science",
    agentId: "agent-test",
    title: "科学展览",
    content: "与科学展览有关的长期主题。",
  });
  const preference = repository.upsertMemory({
    id: "state-science-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    title: "喜欢科学展览",
    content: "用户喜欢科学展览。",
    subjectRole: "user",
    subjectKey: "user:owner",
    canonicalKey: "preference:science-exhibition",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-11T03:00:00.000Z",
  });
  repository.upsertMemory({
    id: "utterance-private",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "原始对话不进入大脑画面。",
  });
  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: event.id,
    episodeId: episode.id,
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: event.id,
    topicId: topic.id,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: preference.id,
    toMemoryId: event.id,
    relation: "established_from",
    weight: 0.86,
  });
  const snapshot = createBrainSnapshot({
    repository,
    agentId: "agent-test",
    cachePath: path.join(root, "brain-layout.json"),
  });

  assert.deepEqual(snapshot.counts, {
    nodes: 4,
    edges: 3,
    major: 2,
    state: 1,
    minor: 1,
  });
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get(episode.id).visualTier, "major");
  assert.equal(byId.get(episode.id).visualFamily, "episode");
  assert.equal(byId.get(topic.id).visualTier, "major");
  assert.equal(byId.get(topic.id).visualFamily, "topic");
  assert.equal(byId.get(preference.id).visualTier, "state");
  assert.equal(byId.get(preference.id).stateFamily, "preference");
  assert.equal(byId.get(event.id).visualTier, "minor");
  assert.deepEqual(new Set(byId.get(event.id).containerIds), new Set([episode.id, topic.id]));
  assert.equal(byId.get(episode.id).memberCount, 1);
  assert.equal(byId.get(topic.id).memberCount, 1);
  assert.equal(snapshot.nodes.some((node) => node.id === "utterance-private"), false);
  assert.deepEqual(
    new Set(snapshot.edges.map((edge) => edge.visualFamily)),
    new Set(["structural", "lifecycle"]),
  );
  for (const node of snapshot.nodes) {
    assert.equal(Number.isFinite(node.position.x), true);
    assert.equal(Number.isFinite(node.position.y), true);
    assert.equal(Number.isFinite(node.position.z), true);
  }
  assert.deepEqual(nodeVisualProfile({ kind: "topic" }), {
    visualTier: "major",
    visualFamily: "topic",
  });
  assert.equal(relationVisualFamily("causes"), "causal");
  assert.equal(relationVisualFamily("future-real-relation"), "associative");
  database.close();
});
