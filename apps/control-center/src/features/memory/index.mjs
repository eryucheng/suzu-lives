import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro, status } from "../../components/panel.mjs";
import {
  bindMemoryBrainEvents,
  renderMemoryBrain,
} from "../memory-brain/index.mjs";

function memoryResultView(result) {
  if (!result) {
    return '<div class="memory-empty">输入一句真实会说的话，查看 Hook 最终会注入什么。不会强制召回不相关内容。</div>';
  }
  if (!result.context) {
    const reason = result.skippedReason === "generic-query"
      ? "这类普通问句不应触发历史回忆。"
      : "没有达到相关性门槛，本次不会向 Agent 注入任何记忆。";
    return `<div class="memory-empty"><strong>不注入</strong><span>${escapeHtml(reason)}</span></div>`;
  }
  return `<div class="memory-result-meta"><span>${escapeHtml(result.retrievalMode || "retrieval")}</span><span>${escapeHtml(result.recallIntent || "auto")}</span><span>${result.candidates?.length || 0} 个候选</span></div><pre class="memory-context">${escapeHtml(result.context)}</pre>`;
}

function memoryStatusLabel(value) {
  return {
    active: "使用中",
    archived: "已归档",
    deleted: "已删除",
    disputed: "有争议",
    superseded: "已替代",
  }[value] || value;
}

function subjectRoleLabel(role, key = "") {
  const label = {
    user: "用户",
    agent: "Agent",
    shared: "双方共同",
    other: "其他人物",
    world: "外部世界",
    unknown: "尚未确定",
  }[role] || role || "尚未确定";
  return key && !["user", "agent", "shared", "world"].includes(role)
    ? `${label} · ${key}`
    : label;
}

function actorRoleLabel(role) {
  return {
    experiencer: "经历者",
    speaker: "说话者",
    observer: "观察者",
    participant: "参与者",
    belief_holder: "观念持有者",
    preference_holder: "偏好持有者",
  }[role] || role;
}

function memoryAttributionView(state) {
  const proposals = state.memoryAttributionProposals;
  if (state.memoryAttributionLoading) {
    return '<div class="memory-attribution-empty"><span class="brain-loader"></span><strong>正在读取待审核提案</strong></div>';
  }
  if (state.memoryAttributionError) {
    return `<div class="memory-attribution-empty"><strong>读取失败</strong><span>${escapeHtml(state.memoryAttributionError)}</span></div>`;
  }
  if (!proposals) {
    return '<div class="memory-attribution-empty">进入此页后才会读取本机已有的待审核提案。</div>';
  }
  if (!proposals.length) {
    return '<div class="memory-attribution-empty"><strong>没有待审核的主体归属</strong><span>只有迁移或分析已经生成提案后，这里才会出现内容。</span></div>';
  }
  return `<div class="memory-attribution-list">${proposals.map((proposal) => {
    const memory = proposal.memory || {};
    const proposalId = escapeHtml(proposal.id);
    const resolving = state.memoryAttributionResolvingId === proposal.id;
    const confidence = Math.round(Number(proposal.confidence || 0) * 100);
    const date = memory.eventDate || memory.eventStart || "时间未记录";
    const roles = Array.isArray(proposal.actorRoles) ? proposal.actorRoles : [];
    const sources = Array.isArray(proposal.evidenceSources) ? proposal.evidenceSources : [];
    return `<article class="memory-attribution-item" data-memory-attribution-card="${proposalId}">
      <div class="memory-attribution-head">
        <div>
          <span class="eyebrow">SUBJECT REVIEW · ${escapeHtml(date)}</span>
          <h2>${escapeHtml(memory.title || "未命名事件")}</h2>
        </div>
        <span class="memory-attribution-confidence">置信度 ${confidence}%</span>
      </div>
      <p class="memory-attribution-content">${escapeHtml(memory.content || "目标记忆已不存在。")}</p>
      <div class="memory-attribution-decision">
        <span>当前：${escapeHtml(subjectRoleLabel(memory.subjectRole, memory.subjectKey))}</span>
        <strong>建议改为：${escapeHtml(subjectRoleLabel(proposal.proposed_subject_role, proposal.proposed_subject_key))}</strong>
      </div>
      <div class="memory-attribution-rationale"><span>判断理由</span><p>${escapeHtml(proposal.rationale || "未提供理由")}</p></div>
      ${roles.length ? `<div class="memory-attribution-roles"><span>人物角色</span><div>${roles.map((role) => (
    `<em>${escapeHtml(subjectRoleLabel(role.actorRole, role.actorKey))} · ${escapeHtml(actorRoleLabel(role.role))}${role.isPrimary ? " · 主要" : ""}</em>`
  )).join("")}</div></div>` : ""}
      <div class="memory-attribution-sources">
        <span>直接来源 ${sources.length} 条</span>
        ${sources.length ? sources.map((source) => `<blockquote>
          <div>${escapeHtml(source.speaker || "说话者未知")} · ${escapeHtml(source.occurredAt || source.knownAt || "时间未知")}</div>
          <p>${escapeHtml(source.content || "")}</p>
        </blockquote>`).join("") : '<p class="memory-attribution-warning">引用来源当前不可用，不能安全接受这条提案。</p>'}
      </div>
      <label class="memory-attribution-note">审核备注（可选）
        <textarea rows="2" ${resolving ? "disabled" : ""} placeholder="例如：来源明确是用户本人经历">${escapeHtml(proposal.pendingNote || "")}</textarea>
      </label>
      <div class="memory-attribution-actions">
        <button class="secondary-button danger-link" type="button" data-memory-attribution-action="dismiss" data-proposal-id="${proposalId}" ${resolving ? "disabled" : ""}>驳回</button>
        <button class="primary-button" type="button" data-memory-attribution-action="accept" data-proposal-id="${proposalId}" ${resolving || !sources.length ? "disabled" : ""}>${resolving ? "处理中…" : "接受归属"}</button>
      </div>
    </article>`;
  }).join("")}</div>`;
}

function memoryStructureView(state) {
  const proposals = state.memoryStructureProposals;
  if (state.memoryStructureLoading) {
    return '<div class="memory-attribution-empty"><span class="brain-loader"></span><strong>正在读取结构候选</strong></div>';
  }
  if (state.memoryStructureError) {
    return `<div class="memory-attribution-empty"><strong>读取失败</strong><span>${escapeHtml(state.memoryStructureError)}</span></div>`;
  }
  if (!proposals) {
    return '<div class="memory-attribution-empty">进入此页后才会读取本机已经生成的结构候选。</div>';
  }
  if (!proposals.length) {
    return '<div class="memory-attribution-empty"><strong>没有待审核的记忆结构</strong><span>新记忆形成 episode 或 topic 候选后，会在这里等待逐条确认。</span></div>';
  }
  return `<div class="memory-attribution-list">${proposals.map((proposal) => {
    const proposalId = escapeHtml(proposal.id);
    const members = Array.isArray(proposal.members) ? proposal.members : [];
    const validation = Array.isArray(proposal.validation) ? proposal.validation : [];
    const resolving = state.memoryStructureResolvingId === proposal.id;
    const isAttach = proposal.operation === "attach";
    const kindLabel = proposal.kind === "episode" ? "事件簇" : "主题";
    const time = proposal.event_date || proposal.event_start || (proposal.kind === "topic" ? "跨时间" : "时间未记录");
    const canAccept = members.length === (proposal.memberIds?.length || 0)
      && (!isAttach || proposal.target);
    return `<article class="memory-attribution-item memory-structure-item" data-memory-structure-card="${proposalId}">
      <div class="memory-attribution-head">
        <div><span class="eyebrow">${isAttach ? "ATTACH" : "CREATE"} ${escapeHtml(proposal.kind.toUpperCase())} · ${escapeHtml(time)}</span><h2>${escapeHtml(proposal.title || proposal.target?.title || `未命名${kindLabel}`)}</h2></div>
        <span class="memory-attribution-confidence">置信度 ${Math.round(Number(proposal.confidence || 0) * 100)}%</span>
      </div>
      <p class="memory-attribution-content">${escapeHtml(proposal.content || proposal.target?.content || "未提供结构摘要")}</p>
      <div class="memory-attribution-decision"><span>动作：${isAttach ? `挂接到现有${kindLabel}` : `创建新${kindLabel}`}</span><strong>主体：${escapeHtml(subjectRoleLabel(proposal.subject_role, proposal.subject_key))}</strong></div>
      ${isAttach ? `<div class="memory-attribution-rationale"><span>目标容器</span><p>${proposal.target ? `${escapeHtml(proposal.target.title || proposal.target.id)} · ${escapeHtml(proposal.target.content || "")}` : "目标容器当前不可用"}</p></div>` : ""}
      <div class="memory-attribution-rationale"><span>形成理由</span><p>${escapeHtml(proposal.rationale || "未提供理由")}</p></div>
      <div class="memory-structure-validation">${validation.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      <div class="memory-structure-members"><span>成员 ${members.length} 条</span>${members.map((memory) => `<section>
        <div><strong>${escapeHtml(memory.title || "未命名记忆")}</strong><em>${escapeHtml(subjectRoleLabel(memory.subjectRole, memory.subjectKey))} · ${escapeHtml(memory.eventDate || memory.eventStart || "时间未知")}</em></div>
        <p>${escapeHtml(memory.content || "")}</p>
        <details><summary>直接证据 ${memory.evidenceSources?.length || 0} 条</summary>${(memory.evidenceSources || []).map((source) => `<blockquote><div>${escapeHtml(source.speaker || "说话者未知")} · ${escapeHtml(source.occurredAt || source.knownAt || "时间未知")} · ${escapeHtml(source.id)}</div><p>${escapeHtml(source.content || "")}</p></blockquote>`).join("") || "<p>暂无直接证据片段</p>"}</details>
      </section>`).join("")}</div>
      ${canAccept ? "" : '<p class="memory-attribution-warning">成员或目标已发生变化，当前不能安全接受。</p>'}
      <label class="memory-attribution-note">审核备注（可选）<textarea rows="2" ${resolving ? "disabled" : ""} placeholder="例如：这些事件确实属于同一次出行">${escapeHtml(proposal.pendingNote || "")}</textarea></label>
      <div class="memory-attribution-actions">
        <button class="secondary-button danger-link" type="button" data-memory-structure-action="dismiss" data-proposal-id="${proposalId}" ${resolving ? "disabled" : ""}>驳回</button>
        <button class="primary-button" type="button" data-memory-structure-action="accept" data-proposal-id="${proposalId}" ${resolving || !canAccept ? "disabled" : ""}>${resolving ? "处理中…" : `接受${kindLabel}`}</button>
      </div>
    </article>`;
  }).join("")}</div>`;
}

function memoryLibraryView(state) {
  const records = state.memoryLibrary;
  if (!records) {
    return '<div class="memory-library-empty">输入关键词可以查找记忆；不输入则查看最近记忆。删除是可恢复的软删除。</div>';
  }
  if (!records.items?.length) {
    return '<div class="memory-library-empty">这个范围内没有找到记忆。</div>';
  }
  return `<div class="memory-library-summary">找到 ${Number(records.total || 0).toLocaleString("zh-CN")} 条，本页显示 ${records.items.length} 条</div>
    <div class="memory-library-list">${records.items.map((memory) => {
    const deleted = memory.status === "deleted";
    const date = memory.event_date || memory.event_start || "";
    return `<article class="memory-library-item ${deleted ? "is-deleted" : ""}">
        <div class="memory-library-item-head">
          <div>
            <strong>${escapeHtml(memory.title || "未命名记忆")}</strong>
            <span>${escapeHtml(memoryStatusLabel(memory.status))} · ${escapeHtml(memory.kind)}${date ? ` · ${escapeHtml(date)}` : ""}</span>
          </div>
          ${state.memoryEditMode ? `<div class="memory-library-actions">
            <button class="quiet-link" data-memory-edit="${escapeHtml(memory.id)}">修改</button>
            ${deleted
    ? `<button class="quiet-link" data-memory-restore="${escapeHtml(memory.id)}">恢复</button>`
    : `<button class="quiet-link danger-link" data-memory-delete="${escapeHtml(memory.id)}">删除</button>`}
          </div>` : ""}
        </div>
        <p>${escapeHtml(memory.content)}</p>
      </article>`;
  }).join("")}</div>`;
}

function memoryEditorView(detail) {
  const memory = detail?.memory;
  if (!memory) return "";
  return `<dialog class="memory-editor" id="memoryEditor">
    <form id="memoryEditorForm">
      <div class="memory-editor-head">
        <div><span class="eyebrow">MANUAL CORRECTION</span><h2>修改记忆</h2></div>
        <button class="dialog-close" type="button" data-memory-edit-cancel aria-label="关闭">×</button>
      </div>
      <label>标题<input name="title" type="text" value="${escapeHtml(memory.title || "")}"></label>
      <label>发生日期<input name="eventDate" type="date" value="${escapeHtml(memory.event_date || "")}"></label>
      <label>记忆正文<textarea name="content" rows="8" required>${escapeHtml(memory.content)}</textarea></label>
      <label>修改说明（可选）<input name="reason" type="text" placeholder="例如：主体写反了、日期有误"></label>
      <div class="memory-editor-meta">
        <span>${escapeHtml(memory.kind)} · ${escapeHtml(memory.layer)}</span>
        <span>${detail.sources?.length || 0} 条来源 · ${detail.edges?.length || 0} 条关联 · ${detail.mutations?.length || 0} 次人工操作</span>
      </div>
      <div class="memory-editor-actions">
        <button class="secondary-button" type="button" data-memory-edit-cancel>取消</button>
        <button class="primary-button" type="submit">保存修改</button>
      </div>
    </form>
  </dialog>`;
}

function memoryPageActions(editMode, viewMode, ready) {
  const modeActions = ready ? [
    ["brain", "记忆大脑"],
    ["library", "列表管理"],
    ["structure", "结构审核"],
    ["attribution", "归属审核"],
  ].map(([mode, label]) => (
    `<button class="secondary-button memory-mode-action ${viewMode === mode ? "is-active" : ""}" type="button" data-memory-mode="${mode}" aria-pressed="${viewMode === mode}">${label}</button>`
  )).join("") : "";
  return `<div class="memory-page-actions">
    <button class="secondary-button memory-edit-toggle ${editMode ? "is-active" : ""}" type="button" data-memory-edit-mode aria-pressed="${editMode}">${editMode ? "完成编辑" : "编辑记忆"}</button>
    ${modeActions}
    <button class="secondary-button" type="button" data-return-relationships>返回关系</button>
  </div>`;
}

export function renderMemory({ state }) {
  const memory = state.memoryStatus || {
    status: "missing",
    memories: 0,
    edges: 0,
    embeddings: 0,
  };
  const ready = memory.status === "ready";
  const requestedMode = state.memoryViewMode || "brain";
  const memoryViewMode = ready && ["brain", "library", "structure", "attribution"].includes(requestedMode)
    ? requestedMode
    : "library";
  const editMode = Boolean(state.memoryEditMode);
  const badge = ready ? status("缓存可用", "ready") : status("尚未建立", "warning");
  const viewState = memoryViewMode === state.memoryViewMode ? state : { ...state, memoryViewMode };
  const intro = pageIntro(
    "RELATIONSHIPS / MEMORY",
    "记忆",
    "查看长期记忆、测试召回，并维护结构化事件之间的联系。",
    memoryPageActions(editMode, memoryViewMode, ready),
  );
  if (memoryViewMode === "brain") {
    return `${intro}${renderMemoryBrain(viewState)}`;
  }
  if (memoryViewMode === "attribution") {
    return `${intro}<section class="memory-attribution-card">
      <div class="memory-attribution-intro">
        <div><span class="eyebrow">HUMAN REVIEW</span><h2>主体归属审核</h2></div>
        <p>这里只审核已经生成的提案。接受会修改正式记忆的主体与人物角色；驳回不会修改记忆。</p>
      </div>
      ${memoryAttributionView(state)}
    </section>`;
  }
  if (memoryViewMode === "structure") {
    return `${intro}<section class="memory-attribution-card memory-structure-card">
      <div class="memory-attribution-intro">
        <div><span class="eyebrow">HUMAN REVIEW</span><h2>记忆结构审核</h2></div>
        <p>这里只审核已经生成的 episode/topic 候选。接受才会创建或挂接正式结构；驳回不会修改记忆图。</p>
      </div>
      ${memoryStructureView(state)}
    </section>`;
  }
  return `${intro}
    <section class="memory-overview">
      <article class="memory-status-card">
        <div class="memory-status-head"><div><span class="eyebrow">MEMORY GRAPH</span><h2>记忆缓存</h2></div>${badge}</div>
        <div class="memory-metrics">
          <div><strong>${Number(memory.memories || 0).toLocaleString("zh-CN")}</strong><span>记忆节点</span></div>
          <div><strong>${Number(memory.edges || 0).toLocaleString("zh-CN")}</strong><span>关联</span></div>
          <div><strong>${Number(memory.embeddings || 0).toLocaleString("zh-CN")}</strong><span>向量</span></div>
        </div>
        <p>${ready ? `当前向量模型：${escapeHtml(memory.embeddingModel || "未配置查询模型")}` : "记忆数据库尚未准备好；聊天和缓存不会写进仓库。"}</p>
      </article>
      <article class="memory-search-card">
        <div class="memory-search-head"><div><span class="eyebrow">RECALL TEST</span><h2>测试最终召回</h2></div><span>${memory.embeddingConfigured ? "混合检索" : "词面检索"}</span></div>
        <div class="memory-search-row">
          <input id="memorySearch" class="search-input" type="search" placeholder="例如：记得我之前去科技馆吗" value="${escapeHtml(state.memoryQuery)}">
          <button id="runMemorySearch" class="primary-button" ${ready ? "" : "disabled"}>测试召回</button>
        </div>
        ${memoryResultView(state.memoryResult)}
      </article>
    </section>
    <section class="memory-library-card">
      <div class="memory-library-head">
        <div><span class="eyebrow">MEMORY LIBRARY</span><h2>查找和维护记忆</h2></div>
        <span>修改后同步更新向量与关联；删除后不再参与召回</span>
      </div>
      <div class="memory-library-controls">
        <input id="memoryLibrarySearch" class="search-input" type="search" placeholder="搜索标题或正文" value="${escapeHtml(state.memoryLibraryQuery)}">
        <select id="memoryLibraryStatus" class="select-input">
          <option value="active" ${state.memoryLibraryStatus === "active" ? "selected" : ""}>使用中</option>
          <option value="deleted" ${state.memoryLibraryStatus === "deleted" ? "selected" : ""}>已删除</option>
          <option value="all" ${state.memoryLibraryStatus === "all" ? "selected" : ""}>全部状态</option>
        </select>
        <button id="loadMemoryLibrary" class="secondary-button" ${ready ? "" : "disabled"}>查记忆库</button>
      </div>
      ${memoryLibraryView(state)}
    </section>
    ${memoryEditorView(state.memoryEditing)}`;
}

export function bindMemoryEvents({
  api,
  refreshData,
  render,
  setNotice,
  state,
}) {
  const loadMemoryLibrary = async () => {
    const statuses = state.memoryLibraryStatus === "all"
      ? ["active", "superseded", "disputed", "archived", "deleted"]
      : [state.memoryLibraryStatus];
    state.memoryLibrary = await api.memory.list({
      query: state.memoryLibraryQuery.trim(),
      statuses,
      limit: 50,
    });
  };

  const loadAttributionProposals = async () => {
    state.memoryAttributionLoading = true;
    state.memoryAttributionError = "";
    try {
      state.memoryAttributionProposals = await api.memory.subjectAttributionProposals({
        reviewStates: ["pending"],
        limit: 100,
      });
    } catch (error) {
      state.memoryAttributionError = error?.message || String(error);
    } finally {
      state.memoryAttributionLoading = false;
    }
  };

  const loadStructureProposals = async () => {
    state.memoryStructureLoading = true;
    state.memoryStructureError = "";
    try {
      state.memoryStructureProposals = await api.memory.structureProposals({
        reviewStates: ["pending"],
        limit: 100,
      });
    } catch (error) {
      state.memoryStructureError = error?.message || String(error);
    } finally {
      state.memoryStructureLoading = false;
    }
  };

  const refreshMemoryUi = async (message) => {
    state.memoryBrainGraph = null;
    state.memoryBrainSelectedId = "";
    state.memoryAttributionProposals = null;
    state.memoryAttributionError = "";
    state.memoryStructureProposals = null;
    state.memoryStructureError = "";
    [state.memoryStatus] = await Promise.all([
      api.memory.status(),
      loadMemoryLibrary(),
    ]);
    render();
    setNotice(message);
  };

  document.querySelectorAll("[data-memory-mode]").forEach((button) => button.addEventListener("click", async () => {
    state.memoryViewMode = button.dataset.memoryMode;
    if (state.memoryViewMode === "attribution") {
      state.memoryAttributionLoading = true;
      state.memoryAttributionError = "";
      render();
      await loadAttributionProposals();
    }
    if (state.memoryViewMode === "structure") {
      state.memoryStructureLoading = true;
      state.memoryStructureError = "";
      render();
      await loadStructureProposals();
    }
    render();
  }));
  document.querySelector("[data-memory-edit-mode]")?.addEventListener("click", () => {
    state.memoryEditMode = !state.memoryEditMode;
    state.memoryEditing = null;
    render();
  });
  document.querySelector("#memorySearch")?.addEventListener("input", (event) => {
    state.memoryQuery = event.target.value;
  });
  document.querySelector("#memorySearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") document.querySelector("#runMemorySearch")?.click();
  });
  document.querySelector("#runMemorySearch")?.addEventListener("click", async (event) => {
    const query = state.memoryQuery.trim();
    if (!query) return setNotice("先输入一句要测试的话。");
    event.currentTarget.disabled = true;
    setNotice("正在检索记忆…");
    try {
      state.memoryResult = await api.memory.search(query);
      setNotice("");
      render();
    } catch (error) {
      setNotice(`检索失败：${error?.message || error}`);
      event.currentTarget.disabled = false;
    }
  });
  document.querySelector("#memoryLibrarySearch")?.addEventListener("input", (event) => {
    state.memoryLibraryQuery = event.target.value;
  });
  document.querySelector("#memoryLibrarySearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") document.querySelector("#loadMemoryLibrary")?.click();
  });
  document.querySelector("#memoryLibraryStatus")?.addEventListener("change", (event) => {
    state.memoryLibraryStatus = event.target.value;
    document.querySelector("#loadMemoryLibrary")?.click();
  });
  document.querySelector("#loadMemoryLibrary")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    setNotice("正在读取记忆库…");
    try {
      await loadMemoryLibrary();
      setNotice("");
      render();
    } catch (error) {
      setNotice(`读取失败：${error?.message || error}`);
      event.currentTarget.disabled = false;
    }
  });
  document.querySelectorAll("[data-memory-edit]").forEach((button) => button.addEventListener("click", async () => {
    setNotice("正在读取记忆详情…");
    try {
      state.memoryEditing = await api.memory.detail(button.dataset.memoryEdit);
      setNotice("");
      render();
      requestAnimationFrame(() => document.querySelector("#memoryEditor")?.showModal());
    } catch (error) {
      setNotice(`读取失败：${error?.message || error}`);
    }
  }));
  document.querySelectorAll("[data-memory-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm("删除后这条记忆将立即退出召回和关联链。仍可在“已删除”中恢复。确定删除吗？")) return;
    setNotice("正在删除记忆…");
    try {
      await api.memory.remove(button.dataset.memoryDelete);
      await refreshMemoryUi("记忆已删除，可在“已删除”中恢复。");
    } catch (error) {
      setNotice(`删除失败：${error?.message || error}`);
    }
  }));
  document.querySelectorAll("[data-memory-restore]").forEach((button) => button.addEventListener("click", async () => {
    setNotice("正在恢复记忆和关联…");
    try {
      await api.memory.restore(button.dataset.memoryRestore);
      await refreshMemoryUi("记忆已恢复。");
    } catch (error) {
      setNotice(`恢复失败：${error?.message || error}`);
    }
  }));
  document.querySelectorAll("[data-memory-edit-cancel]").forEach((button) => button.addEventListener("click", () => {
    state.memoryEditing = null;
    render();
  }));
  document.querySelector("#memoryEditor")?.addEventListener("cancel", (event) => {
    event.preventDefault();
    state.memoryEditing = null;
    render();
  });
  document.querySelector("#memoryEditorForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const memoryId = state.memoryEditing?.memory?.id;
    if (!memoryId) return;
    const form = new FormData(event.currentTarget);
    const content = String(form.get("content") || "").trim();
    if (!content) return setNotice("记忆正文不能为空。");
    setNotice("正在保存修改并重建关联…");
    try {
      const result = await api.memory.edit(memoryId, {
        title: String(form.get("title") || ""),
        eventDate: String(form.get("eventDate") || ""),
        content,
      }, String(form.get("reason") || ""));
      state.memoryEditing = null;
      const message = result.embedding?.status === "updated"
        ? "记忆已修改，向量和关联已同步更新。"
        : result.warnings?.[0] || "记忆已修改；当前没有可用向量配置，已使用词面检索。";
      await refreshMemoryUi(message);
    } catch (error) {
      setNotice(`保存失败：${error?.message || error}`);
    }
  });
  document.querySelectorAll("[data-memory-attribution-action]").forEach((button) => button.addEventListener("click", async () => {
    const proposalId = button.dataset.proposalId;
    const action = button.dataset.memoryAttributionAction;
    const card = button.closest("[data-memory-attribution-card]");
    const note = card?.querySelector(".memory-attribution-note textarea")?.value || "";
    if (!proposalId || !["accept", "dismiss"].includes(action)) return;
    if (action === "accept" && !window.confirm("接受后会更新这条正式记忆的主体和人物角色。确定来源与建议归属一致吗？")) return;
    state.memoryAttributionResolvingId = proposalId;
    render();
    setNotice(action === "accept" ? "正在接受主体归属…" : "正在驳回主体归属…");
    try {
      await api.memory.resolveSubjectAttribution(proposalId, action, note);
      [state.memoryAttributionProposals, state.memoryStatus] = await Promise.all([
        api.memory.subjectAttributionProposals({ reviewStates: ["pending"], limit: 100 }),
        api.memory.status(),
      ]);
      state.memoryBrainGraph = null;
      state.memoryLibrary = null;
      setNotice(action === "accept" ? "主体归属已接受，正式记忆已更新。" : "主体归属提案已驳回，正式记忆未修改。");
    } catch (error) {
      setNotice(`审核失败：${error?.message || error}`);
    } finally {
      state.memoryAttributionResolvingId = "";
      render();
    }
  }));
  document.querySelectorAll("[data-memory-structure-action]").forEach((button) => button.addEventListener("click", async () => {
    const proposalId = button.dataset.proposalId;
    const action = button.dataset.memoryStructureAction;
    const card = button.closest("[data-memory-structure-card]");
    const note = card?.querySelector(".memory-attribution-note textarea")?.value || "";
    if (!proposalId || !["accept", "dismiss"].includes(action)) return;
    if (action === "accept" && !window.confirm("接受后会修改正式记忆图。请确认这些成员确实属于这个事件簇或主题。")) return;
    state.memoryStructureResolvingId = proposalId;
    render();
    setNotice(action === "accept" ? "正在写入记忆结构…" : "正在驳回结构候选…");
    try {
      await api.memory.resolveStructure(proposalId, action, note);
      [state.memoryStructureProposals, state.memoryStatus] = await Promise.all([
        api.memory.structureProposals({ reviewStates: ["pending"], limit: 100 }),
        api.memory.status(),
      ]);
      state.memoryBrainGraph = null;
      state.memoryLibrary = null;
      setNotice(action === "accept" ? "记忆结构已写入。" : "结构候选已驳回，正式记忆图未修改。");
    } catch (error) {
      setNotice(`审核失败：${error?.message || error}`);
    } finally {
      state.memoryStructureResolvingId = "";
      render();
    }
  }));
  if (state.memoryStatus?.status === "ready" && (state.memoryViewMode || "brain") === "brain") {
    bindMemoryBrainEvents({ api, render, setNotice, state });
  }
}
