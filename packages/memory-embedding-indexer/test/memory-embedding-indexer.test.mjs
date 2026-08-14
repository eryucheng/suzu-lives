import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";

import {
  buildMemoryEmbeddingDocument,
  syncMemoryEmbeddings,
} from "../src/index.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-indexer-"));
  const database = openMemoryDatabase(path.join(root, "memory.db"));
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "relationship-state",
    agentId: "agent-test",
    kind: "relationship",
    layer: "relational",
    title: "双方是恋人关系",
    content: "用户明确把 Agent 当成恋人。",
    subjectRole: "user",
    subjectKey: "user",
    stateFamily: "relationship",
    statePhase: "active",
    temporalState: "current",
    reality: "real",
  });
  repository.upsertMemory({
    id: "museum-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆之行",
    content: "用户周六去了科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-11",
    reality: "real",
  });
  repository.upsertMemory({
    id: "raw-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "这是不应送去普通向量索引的原话。",
    subjectRole: "user",
    subjectKey: "user",
  });
  return { root, database, repository };
}

function fakeProvider({ dimensions = 3, fail = false } = {}) {
  const calls = [];
  const provider = async (text) => {
    const response = await provider.embedMany([text]);
    return { ...response, vector: response.vectors[0] };
  };
  provider.model = "text-embedding-v4";
  provider.dimensions = dimensions;
  provider.embedMany = async (texts) => {
    calls.push([...texts]);
    if (fail) throw new Error("provider failed");
    return {
      model: provider.model,
      vectors: texts.map((text, index) => Float32Array.from(
        Array.from({ length: dimensions }, (_, dimension) => text.length + index + dimension + 1),
      )),
      usage: { prompt_tokens: texts.length * 10, total_tokens: texts.length * 10 },
      requestId: `request-${calls.length}`,
      metadata: { provider: "fake" },
    };
  };
  provider.calls = calls;
  return provider;
}

test("builds deterministic text from semantic fields without metadata noise", () => {
  const text = buildMemoryEmbeddingDocument({
    id: "memory-1",
    kind: "relationship",
    title: "关系",
    content: "用户把 Agent 当成恋人。",
    subject_role: "user",
    subject_key: "user",
    reality: "real",
    metadata: { privateNoise: "不应进入向量" },
  });
  assert.match(text, /记忆类型：relationship/u);
  assert.match(text, /主体角色：user/u);
  assert.doesNotMatch(text, /privateNoise|不应进入向量/u);
});

test("indexes only long-term nodes, reuses hashes, and reindexes a changed node", async () => {
  const { database, repository } = fixture();
  const provider = fakeProvider();
  const first = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
  });
  assert.equal(first.added, 2);
  assert.equal(first.excludedByKind, 1);
  assert.equal(provider.calls.length, 1);
  assert.doesNotMatch(provider.calls.flat().join("\n"), /不应送去普通向量索引/u);

  const second = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
  });
  assert.equal(second.added, 0);
  assert.equal(second.reused, 2);
  assert.equal(provider.calls.length, 1);

  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: "museum-event",
    patch: { content: "用户周六去了科技馆并参观机器人展。" },
    reason: "test",
  });
  const third = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
  });
  assert.equal(third.added, 1);
  assert.equal(third.reused, 1);
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls.at(-1)[0], /机器人展/u);
  database.close();
});

test("records API usage and leaves existing vectors intact when a rebuild fails", async () => {
  const { root, database, repository } = fixture();
  const ledgerPath = path.join(root, "usage-events.jsonl");
  const provider = fakeProvider();
  await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    ledgerPath,
  });
  const events = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].feature, "memory-index-embedding");

  const before = repository.listEmbeddings("agent-test", provider.model);
  const failed = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: fakeProvider({ fail: true }),
    force: true,
    maxRetries: 0,
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.failed, 2);
  const after = repository.listEmbeddings("agent-test", provider.model);
  assert.deepEqual(
    after.map((item) => [item.memory_id, item.content_hash]).sort(),
    before.map((item) => [item.memory_id, item.content_hash]).sort(),
  );
  database.close();
});

test("does not write a batch when vector dimensions are inconsistent", async () => {
  const { database, repository } = fixture();
  const provider = fakeProvider({ dimensions: 4 });
  const result = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    dimensions: 3,
  });
  assert.equal(result.status, "error");
  assert.equal(repository.listEmbeddings("agent-test", provider.model).length, 0);
  database.close();
});
