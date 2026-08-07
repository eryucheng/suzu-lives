import assert from "node:assert/strict";
import test from "node:test";

import { state as controlCenterState } from "../src/core/state.mjs";
import {
  renderMemoryBrain,
  renderMemoryBrainDetail,
} from "../src/features/memory-brain/index.mjs";
import { memoryBrainEdgeMode } from "../src/features/memory-brain/brain-view.mjs";
import { renderMemory } from "../src/features/memory/index.mjs";

const memory = {
  id: "event-a",
  title: "第一次见面",
  content: "这是结构化事件，不是原始对话。",
  status: "active",
  kind: "event",
  layer: "episodic",
  event_date: "2026-07-01",
};

const deletedMemory = {
  ...memory,
  id: "event-deleted",
  title: "已删除的记忆",
  status: "deleted",
};

test("renders a full brain stage without a default detail panel or redundant reset action", () => {
  const state = {
    memoryBrainGraph: {
      nodes: [{
        ...memory,
        preview: "这是结构化事件，不是原始对话。",
        eventDate: "2026-07-01",
      }],
      edges: [],
    },
    memoryBrainLoading: false,
    memoryEditMode: false,
    memoryViewMode: "brain",
  };
  const view = renderMemoryBrain(state);
  assert.match(view, /id="memoryBrainCanvas"/u);
  assert.match(view, /1 个节点/u);
  assert.match(view, /0 个大神经元/u);
  assert.match(view, /0 个人物状态/u);
  assert.match(view, /主题 \/ 事件簇/u);
  assert.match(view, /人物状态/u);
  assert.match(view, /具体记忆/u);
  assert.match(view, /第一次见面/u);
  assert.match(view, /双击回到全景/u);
  assert.match(view, /id="memoryBrainDetail" class="memory-brain-detail" aria-live="polite" hidden><\/aside>/u);
  assert.doesNotMatch(view, /resetMemoryBrain/u);
  assert.doesNotMatch(view, />复位</u);
  assert.doesNotMatch(view, /选择一个记忆神经元/u);
  assert.doesNotMatch(view, /brain-detail-empty/u);
  assert.doesNotMatch(view, /这是结构化事件，不是原始对话。/u);
});

test("hides persistent graph lines and reveals only ambient or direct edges", () => {
  const direct = { id: "edge-direct", source: "selected", target: "neighbor" };
  const secondHop = { id: "edge-second-hop", source: "neighbor", target: "far-node" };
  assert.equal(memoryBrainEdgeMode(direct), "hidden");
  assert.equal(memoryBrainEdgeMode(direct, { ambientStrength: 0.7 }), "ambient");
  assert.equal(memoryBrainEdgeMode(direct, { selectedId: "selected", ambientStrength: 0.7 }), "direct");
  assert.equal(memoryBrainEdgeMode(secondHop, { selectedId: "selected", ambientStrength: 0.7 }), "hidden");
});

test("defaults to brain browsing and exposes management controls only in edit mode", () => {
  assert.equal(controlCenterState.memoryViewMode, "brain");
  assert.equal(controlCenterState.memoryEditMode, false);
  const baseState = {
    memoryStatus: {
      status: "ready",
      memories: 8,
      edges: 3,
      embeddings: 8,
    },
    memoryViewMode: "brain",
    memoryEditMode: false,
    memoryQuery: "",
    memoryResult: null,
    memoryLibraryQuery: "",
    memoryLibraryStatus: "active",
    memoryLibrary: {
      total: 2,
      items: [memory, deletedMemory],
    },
    memoryEditing: null,
    memoryBrainGraph: { nodes: [], edges: [] },
    memoryBrainLoading: false,
    memoryAttributionProposals: null,
    memoryAttributionLoading: false,
    memoryAttributionError: "",
    memoryAttributionResolvingId: "",
    memoryStructureProposals: null,
    memoryStructureLoading: false,
    memoryStructureError: "",
    memoryStructureResolvingId: "",
  };
  const brainView = renderMemory({ state: baseState });
  assert.match(brainView, /RELATIONSHIPS \/ MEMORY/u);
  assert.match(brainView, /data-return-relationships/u);
  assert.match(brainView, /id="memoryBrainCanvas"/u);
  assert.match(brainView, /data-memory-edit-mode aria-pressed="false">编辑记忆[\s\S]*data-memory-mode="brain" aria-pressed="true">记忆大脑[\s\S]*data-memory-mode="library" aria-pressed="false">列表管理[\s\S]*data-memory-mode="structure" aria-pressed="false">结构审核[\s\S]*data-memory-mode="attribution" aria-pressed="false">归属审核[\s\S]*data-return-relationships>返回关系/u);
  assert.doesNotMatch(brainView, /memory-mode-switch/u);
  assert.doesNotMatch(brainView, /memory-library-card/u);

  const browseLibrary = renderMemory({
    state: { ...baseState, memoryViewMode: "library" },
  });
  assert.match(browseLibrary, /data-memory-mode="brain" aria-pressed="false">记忆大脑[\s\S]*data-memory-mode="library" aria-pressed="true">列表管理[\s\S]*data-memory-mode="structure" aria-pressed="false">结构审核[\s\S]*data-memory-mode="attribution" aria-pressed="false">归属审核/u);
  assert.doesNotMatch(browseLibrary, /memory-mode-switch/u);
  assert.doesNotMatch(browseLibrary, /data-memory-edit=/u);
  assert.doesNotMatch(browseLibrary, /data-memory-delete=/u);
  assert.doesNotMatch(browseLibrary, /data-memory-restore=/u);

  const editingLibrary = renderMemory({
    state: { ...baseState, memoryEditMode: true, memoryViewMode: "library" },
  });
  assert.match(editingLibrary, /data-memory-edit="event-a"/u);
  assert.match(editingLibrary, /data-memory-delete="event-a"/u);
  assert.match(editingLibrary, /data-memory-restore="event-deleted"/u);
  assert.match(editingLibrary, /data-memory-edit-mode aria-pressed="true">完成编辑/u);

  const attributionReview = renderMemory({
    state: {
      ...baseState,
      memoryViewMode: "attribution",
      memoryAttributionProposals: [{
        id: "subject-proposal-a",
        confidence: 0.96,
        proposed_subject_role: "user",
        proposed_subject_key: "user",
        rationale: "用户以第一人称明确说自己去了科技馆。",
        actorRoles: [{
          role: "experiencer",
          actorRole: "user",
          actorKey: "user",
          isPrimary: true,
        }],
        memory: {
          id: "event-a",
          title: "第一次见面",
          content: "这是结构化事件，不是原始对话。",
          kind: "event",
          subjectRole: "unknown",
          eventDate: "2026-07-01",
        },
        evidenceSources: [{
          id: "source-a",
          speaker: "User",
          occurredAt: "2026-07-01T10:00:00.000Z",
          content: "我那天去了科技馆。",
        }],
      }],
    },
  });
  assert.match(attributionReview, /主体归属审核/u);
  assert.match(attributionReview, /建议改为：用户/u);
  assert.match(attributionReview, /我那天去了科技馆/u);
  assert.match(attributionReview, /data-memory-attribution-action="dismiss"/u);
  assert.match(attributionReview, /data-memory-attribution-action="accept"/u);

  const structureReview = renderMemory({
    state: {
      ...baseState,
      memoryViewMode: "structure",
      memoryStructureProposals: [{
        id: "structure-proposal-a",
        operation: "create",
        kind: "episode",
        title: "科技馆之行",
        content: "参观科技馆并一起吃饭的连续经历。",
        subject_role: "shared",
        subject_key: "agent:user",
        event_date: "2026-07-01",
        memberIds: ["event-a"],
        members: [{
          id: "event-a",
          title: "去了科技馆",
          content: "用户去了科技馆。",
          subjectRole: "user",
          subjectKey: "user",
          eventDate: "2026-07-01",
          evidenceSources: [{
            id: "source-a",
            speaker: "User",
            occurredAt: "2026-07-01T10:00:00.000Z",
            content: "我今天去了科技馆。",
          }],
        }],
        validation: ["创建 episode", "1/1 个成员当前可读取"],
        confidence: 0.9,
        rationale: "属于同一段连续经历。",
      }],
    },
  });
  assert.match(structureReview, /记忆结构审核/u);
  assert.match(structureReview, /科技馆之行/u);
  assert.match(structureReview, /我今天去了科技馆/u);
  assert.match(structureReview, /data-memory-structure-action="dismiss"/u);
  assert.match(structureReview, /data-memory-structure-action="accept"/u);

  const detail = {
    memory,
    sources: [{ id: "source-a" }],
  };
  const browseDetail = renderMemoryBrainDetail(detail, { edges: [] }, false);
  const editingDetail = renderMemoryBrainDetail(detail, { edges: [] }, true);
  assert.match(browseDetail, /SELECTED MEMORY/u);
  assert.match(browseDetail, /第一次见面/u);
  assert.doesNotMatch(browseDetail, /data-brain-edit=/u);
  assert.doesNotMatch(browseDetail, /data-brain-delete=/u);
  assert.match(editingDetail, /data-brain-edit="event-a"/u);
  assert.match(editingDetail, /data-brain-delete="event-a"/u);

  const unavailableMemory = renderMemory({
    state: {
      ...baseState,
      memoryStatus: { status: "missing", memories: 0, edges: 0, embeddings: 0 },
      memoryViewMode: "brain",
    },
  });
  assert.match(unavailableMemory, /memory-library-card/u);
  assert.doesNotMatch(unavailableMemory, /data-memory-mode=/u);
});
