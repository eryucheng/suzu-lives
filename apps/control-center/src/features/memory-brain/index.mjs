import { escapeHtml } from "../../core/formatters.mjs";
import { createMemoryBrainView } from "./brain-view.mjs";

let activeViewer = null;

function relationLabel(value) {
  return {
    part_of_episode: "属于事件簇",
    supports_topic: "支持主题",
    associated_with: "语义关联",
    timeline_next: "时间后续",
    same_thread: "同一发展线",
    followed_by: "对话后续",
    supported_by: "直接证据",
    challenged_by: "相反证据",
    causes: "因果关系",
    shares_entity: "共同人物或事物",
    corrects: "纠正",
    supersedes: "替代",
    contradicts: "冲突",
    scoped_exception_to: "局部例外",
    established_from: "由此形成",
    completes: "完成",
    cancels: "取消",
  }[value] || value;
}

function memoryKindLabel(value) {
  return {
    event: "具体事件",
    episode: "事件簇",
    topic: "主题",
    fact: "事实状态",
    belief_state: "观念状态",
    preference: "偏好状态",
    relationship: "关系状态",
    plan: "计划",
    commitment: "承诺",
    open_loop: "未完事项",
    derived_hypothesis: "推导认识",
    reflection: "反思",
    topic_or_episode: "旧版主题节点",
  }[value] || value || "记忆";
}

function visualTierLabel(node) {
  return {
    major: "大神经元",
    state: "人物状态",
    minor: "具体记忆",
  }[node?.visualTier] || memoryKindLabel(node?.kind);
}

function memoryDate(memory) {
  return memory?.event_date || memory?.eventDate || memory?.event_start || memory?.eventStart || "时间不详";
}

function nodeCard(node) {
  if (!node) {
    return `<div class="brain-detail-empty">
      <span class="brain-detail-orb"></span>
      <strong>选择一个记忆神经元</strong>
      <p>点击光点后，大脑会将它带到中央并点亮相关记忆。</p>
    </div>`;
  }
  return `<div class="brain-detail-content">
    <span class="eyebrow">SELECTED MEMORY</span>
    <div class="brain-detail-date">${escapeHtml(memoryDate(node))}</div>
    <h2>${escapeHtml(node.title || "未命名记忆")}</h2>
    <p>${escapeHtml(node.preview || "正在读取记忆详情…")}</p>
    <div class="brain-detail-tags">
      <span>${escapeHtml(visualTierLabel(node))}</span>
      <span>${escapeHtml(memoryKindLabel(node.kind))}</span>
      <span>重要度 ${Math.round(Number(node.importance || 0) * 100)}%</span>
    </div>
  </div>`;
}

export function renderMemoryBrainDetail(detail, graph, editMode = false) {
  const memory = detail?.memory;
  if (!memory) return nodeCard(null);
  const graphEdges = (graph?.edges || []).filter((edge) => (
    edge.source === memory.id || edge.target === memory.id
  ));
  const relationTags = [...new Set(graphEdges.map((edge) => relationLabel(edge.relation)))];
  return `<div class="brain-detail-content">
    <span class="eyebrow">SELECTED MEMORY</span>
    <div class="brain-detail-date">${escapeHtml(memoryDate(memory))}</div>
    <h2>${escapeHtml(memory.title || "未命名记忆")}</h2>
    <p>${escapeHtml(memory.content)}</p>
    <div class="brain-detail-tags">
      <span>${escapeHtml(memoryKindLabel(memory.kind))}</span>
      <span>${detail.sources?.length || 0} 条原始证据</span>
      <span>${graphEdges.length} 条记忆关联</span>
    </div>
    ${relationTags.length ? `<div class="brain-relation-tags">${relationTags.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
    ${editMode ? `<div class="brain-detail-actions">
      <button class="secondary-button" data-brain-edit="${escapeHtml(memory.id)}">修改</button>
      <button class="quiet-link danger-link" data-brain-delete="${escapeHtml(memory.id)}">删除</button>
    </div>` : ""}
  </div>`;
}

function showBrainDetail(card, content) {
  if (!card) return;
  card.hidden = false;
  card.innerHTML = content;
}

function hideBrainDetail(card) {
  if (!card) return;
  card.innerHTML = "";
  card.hidden = true;
}

export function renderMemoryBrain(state) {
  const graph = state.memoryBrainGraph;
  const nodeCount = graph?.nodes?.length || 0;
  const edgeCount = graph?.edges?.length || 0;
  const majorCount = graph?.counts?.major
    ?? graph?.nodes?.filter((node) => node.visualTier === "major").length
    ?? 0;
  const stateCount = graph?.counts?.state
    ?? graph?.nodes?.filter((node) => node.visualTier === "state").length
    ?? 0;
  const loading = state.memoryBrainLoading;
  return `<section class="memory-brain-card">
    <div class="memory-brain-toolbar">
      <div>
        <span class="eyebrow">MEMORY BRAIN</span>
        <h2>记忆神经网络</h2>
      </div>
      <div class="memory-brain-stats">
        <span>${nodeCount.toLocaleString("zh-CN")} 个节点</span>
        <span>${majorCount.toLocaleString("zh-CN")} 个大神经元</span>
        <span>${stateCount.toLocaleString("zh-CN")} 个人物状态</span>
        <span>${edgeCount.toLocaleString("zh-CN")} 条真实关联</span>
      </div>
      <div class="memory-brain-search">
        <input id="memoryBrainSearch" class="search-input" type="search" list="memoryBrainOptions" placeholder="搜索记忆、主题或状态">
        <datalist id="memoryBrainOptions">${(graph?.nodes || []).map((node) => `<option value="${escapeHtml(node.title)}"></option>`).join("")}</datalist>
        <button id="focusMemoryBrain" class="secondary-button" ${nodeCount ? "" : "disabled"}>定位</button>
      </div>
    </div>
    <div class="memory-brain-stage">
      <canvas id="memoryBrainCanvas" tabindex="0" aria-label="可旋转的三维记忆大脑"></canvas>
      ${loading ? '<div class="memory-brain-loading"><span class="brain-loader"></span><strong>正在组织记忆空间…</strong></div>' : ""}
      ${!loading && graph && !nodeCount ? '<div class="memory-brain-loading"><strong>还没有结构化记忆</strong><span>原始对话不会直接堆进大脑视图。</span></div>' : ""}
      <aside id="memoryBrainDetail" class="memory-brain-detail" aria-live="polite" hidden></aside>
      <div class="memory-brain-hint">
        <span class="brain-legend-major">主题 / 事件簇</span>
        <span class="brain-legend-state">人物状态</span>
        <span class="brain-legend-minor">具体记忆</span>
        <span>拖动浏览 · 滚轮缩放 · 双击回到全景</span>
      </div>
    </div>
  </section>`;
}

function bindDetailActions({
  api,
  detail,
  render,
  setNotice,
  state,
}) {
  const memoryId = detail?.memory?.id;
  if (!memoryId) return;
  document.querySelector("[data-brain-edit]")?.addEventListener("click", () => {
    state.memoryEditing = detail;
    state.memoryViewMode = "library";
    render();
    requestAnimationFrame(() => document.querySelector("#memoryEditor")?.showModal());
  });
  document.querySelector("[data-brain-delete]")?.addEventListener("click", async () => {
    if (!window.confirm("删除后这条记忆会立即从召回和记忆大脑中消失，仍可在列表的“已删除”中恢复。确定删除吗？")) return;
    setNotice("正在删除记忆…");
    try {
      await api.memory.remove(memoryId);
      state.memoryBrainGraph = null;
      state.memoryBrainSelectedId = "";
      state.memoryStatus = await api.memory.status();
      setNotice("");
      render();
    } catch (error) {
      setNotice(`删除失败：${error?.message || error}`);
    }
  });
}

export function bindMemoryBrainEvents({
  api,
  render,
  setNotice,
  state,
}) {
  activeViewer?.destroy();
  activeViewer = null;
  if (!state.memoryBrainGraph && !state.memoryBrainLoading) {
    state.memoryBrainLoading = true;
    const request = api.memory.brainGraph();
    render();
    request.then((graph) => {
      state.memoryBrainGraph = graph;
      state.memoryBrainLoading = false;
      render();
    }).catch((error) => {
      state.memoryBrainLoading = false;
      setNotice(`记忆大脑读取失败：${error?.message || error}`);
      render();
    });
    return;
  }
  const canvas = document.querySelector("#memoryBrainCanvas");
  if (!canvas || !state.memoryBrainGraph?.nodes?.length) return;
  activeViewer = createMemoryBrainView(canvas, state.memoryBrainGraph, {
    onSelect: async (node) => {
      state.memoryBrainSelectedId = node.id;
      const card = document.querySelector("#memoryBrainDetail");
      if (!card) return;
      showBrainDetail(card, nodeCard(node));
      try {
        const detail = await api.memory.detail(node.id);
        if (!card.isConnected || activeViewer?.selectedId() !== node.id) return;
        showBrainDetail(card, renderMemoryBrainDetail(detail, state.memoryBrainGraph, state.memoryEditMode));
        if (state.memoryEditMode) bindDetailActions({ api, detail, render, setNotice, state });
      } catch (error) {
        if (card.isConnected) {
          showBrainDetail(card, `${nodeCard(node)}<div class="brain-detail-error">详情读取失败：${escapeHtml(error?.message || error)}</div>`);
        }
      }
    },
    onReset: () => {
      state.memoryBrainSelectedId = "";
      const card = document.querySelector("#memoryBrainDetail");
      hideBrainDetail(card);
    },
  });
  if (state.memoryBrainSelectedId) activeViewer.focusNode(state.memoryBrainSelectedId);
  const focusSearch = () => {
    const query = String(document.querySelector("#memoryBrainSearch")?.value || "").trim().toLocaleLowerCase("zh-CN");
    if (!query) return setNotice("先输入要定位的记忆。");
    const candidates = state.memoryBrainGraph.nodes.filter((node) => (
      `${node.title}\n${node.preview}\n${node.eventDate}`.toLocaleLowerCase("zh-CN").includes(query)
    ));
    if (!candidates.length) return setNotice("没有找到匹配的记忆神经元。");
    setNotice(candidates.length > 1 ? `找到 ${candidates.length} 条，已定位最接近的一条。` : "");
    activeViewer.focusNode(candidates[0].id);
  };
  document.querySelector("#focusMemoryBrain")?.addEventListener("click", focusSearch);
  document.querySelector("#memoryBrainSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") focusSearch();
  });
}
