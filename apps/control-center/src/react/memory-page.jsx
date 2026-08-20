import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, Dialog, Empty, GlassPanel, Input, PageHeader, Select, Status, Switch, Tabs, Textarea } from "suzu-design-system";

import { API_BINDINGS } from "../features/agent/runtime.mjs";
import { createMemoryBrainView } from "../features/memory-brain/brain-view.mjs";
import { ApiConnectionPicker } from "./api-connections-ui.jsx";

import "./memory-page.css";

const REVIEW_TYPES = Object.freeze([
  ["all", "全部类型"],
  ["ingestion", "记忆入库"],
  ["reported-state", "人物状态"],
  ["structure", "主题与事件簇"],
  ["relation", "关系关联"],
  ["maintenance-failure", "维护失败"],
]);

const REVIEW_STATES = Object.freeze([
  ["pending", "待审核"],
  ["accepted", "已接受"],
  ["dismissed", "已驳回"],
  ["revoked", "已撤销"],
]);

const MEMORY_VIEW_TABS = Object.freeze([
  { label: "记忆大脑", value: "brain" },
  { label: "列表管理", value: "library" },
  { label: "审核中心", value: "review" },
]);

const REVIEW_TYPE_LABELS = Object.freeze(Object.fromEntries(REVIEW_TYPES.filter(([value]) => value !== "all")));
const REVIEW_STATE_LABELS = Object.freeze(Object.fromEntries(REVIEW_STATES));
const LIBRARY_STATUSES = Object.freeze(["active", "superseded", "disputed", "archived", "deleted"]);
const EMPTY_MEMORY_GRAPH = Object.freeze({
  counts: { edges: 0, major: 0, state: 0 },
  edges: [],
  nodes: [],
});

function clean(value) {
  return String(value ?? "").trim();
}

function contactName(contact) {
  return clean(contact?.name) || "未命名联系人";
}

function numberText(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function dateText(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function shortId(value) {
  const text = clean(value);
  return text.length > 24 ? `${text.slice(0, 11)}…${text.slice(-8)}` : text;
}

function percentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "待判断";
}

function plainText(value, fallback = "—") {
  if (value === undefined || value === null || value === "") return fallback;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => plainText(item, "")).filter(Boolean).join("、") || fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function jsonText(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "无法序列化这条审计记录。";
  }
}

function memoryStatusLabel(value) {
  return {
    active: "使用中",
    archived: "已归档",
    deleted: "已删除",
    disputed: "有争议",
    superseded: "已替代",
  }[value] || clean(value) || "未知";
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
    actor_entity: "人物主体",
    relationship_context: "关系容器",
  }[value] || clean(value) || "记忆";
}

function visualTierLabel(node) {
  if (node?.graphNodeType === "actor") return "人物根节点";
  if (node?.graphNodeType === "relationship") return "关系根节点";
  return {
    major: "大神经元",
    state: "人物状态",
    minor: "具体记忆",
  }[node?.visualTier] || memoryKindLabel(node?.kind);
}

function structureReviewLabel(node) {
  return node?.structureReviewState === "pending" ? "未审核结构" : "";
}

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
    about_subject: "关于该主体",
    belongs_to_relationship: "归入关系",
    member_of_relationship: "关系成员",
  }[value] || clean(value);
}

function memoryDate(memory) {
  return memory?.event_date || memory?.eventDate || memory?.event_start || memory?.eventStart || "时间不详";
}

function reviewKey(type, id) {
  return JSON.stringify([clean(type), clean(id)]);
}

function MemoryResult({ result }) {
  if (!result) {
    return <div className="memory-empty">输入一句真实会说的话，查看 Hook 最终会注入什么。不会强制召回不相关内容。</div>;
  }
  if (!result.context) {
    const reason = result.skippedReason === "generic-query"
      ? "这类普通问句不应触发历史回忆。"
      : "没有达到相关性门槛，本次不会向 Agent 注入任何记忆。";
    return <div className="memory-empty"><strong>不注入</strong><span>{reason}</span></div>;
  }
  return <>
    <div className="memory-result-meta">
      <span>{result.retrievalMode || "retrieval"}</span>
      <span>{result.recallIntent || "auto"}</span>
      <span>{result.candidates?.length || 0} 个候选</span>
    </div>
    <pre className="memory-context">{result.context}</pre>
  </>;
}

function RecallTest({ api, contactId, disabled, onError, onSuccess }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState(false);

  const search = async () => {
    const normalized = clean(query);
    if (!normalized) {
      onError("先输入一句要测试的话。");
      return;
    }
    setPending(true);
    onSuccess("正在检索记忆…");
    try {
      const next = await api.memory.search(normalized, { contactId });
      setResult(next);
      onSuccess("");
    } catch (error) {
      onError(`检索失败：${error?.message || error}`);
    } finally {
      setPending(false);
    }
  };

  return <article className="memory-search-card">
    <div className="memory-search-head"><div><span className="eyebrow">RECALL TEST</span><h2>测试最终召回</h2></div><span>测试这位联系人的记忆</span></div>
    <div className="memory-search-row">
      <input
        className="search-input"
        disabled={disabled || pending}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void search();
          }
        }}
        placeholder="例如：记得我之前去科技馆吗"
        type="search"
        value={query}
      />
      <Button disabled={disabled || pending} onClick={() => void search()} type="button">{pending ? "检索中…" : "测试召回"}</Button>
    </div>
    <MemoryResult result={result} />
  </article>;
}

function MemoryOverview({ api, contactId, memory, onError, onSuccess }) {
  const ready = memory?.status === "ready";
  const embeddingReady = memory?.embeddingConfigured === true;
  const statusLabel = !ready ? "尚未建立" : embeddingReady ? "缓存可用" : "向量未配置";
  const statusTone = !ready || !embeddingReady ? "warning" : "success";
  return <section className="memory-overview">
    <article className="memory-status-card">
      <div className="memory-status-head">
        <div><span className="eyebrow">MEMORY GRAPH</span><h2>记忆缓存</h2></div>
        <Status label={statusLabel} tone={statusTone} />
      </div>
      <div className="memory-metrics">
        <div><strong>{numberText(memory?.memories)}</strong><span>记忆节点</span></div>
        <div><strong>{numberText(memory?.edges)}</strong><span>关联</span></div>
        <div><strong>{numberText(memory?.embeddings)}</strong><span>向量</span></div>
      </div>
      <p>{ready ? <>
        当前向量模型：{memory?.embeddingModel || "未配置"}{embeddingReady ? "" : "；未配置向量 API 时检索会降级为词面匹配"}<br />
        自动整理模型：{memory?.generationConfigured
          ? `${memory?.generationModel || "当前主模型"}（已配置）`
          : "未配置；新的记忆会保留为待整理"}
      </> : "记忆数据库尚未准备好；聊天和缓存不会写进仓库。"}</p>
    </article>
    <RecallTest api={api} contactId={contactId} disabled={!ready} onError={onError} onSuccess={onSuccess} />
  </section>;
}

function ContactPicker({ contacts, onClose, onSelect, open, selectedContactId, switching }) {
  if (!open) return null;
  return <div className="memory-contact-picker-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }} role="presentation">
    <aside aria-labelledby="memoryContactPickerTitle" aria-modal="true" className="memory-contact-picker" role="dialog">
      <header>
        <h2 id="memoryContactPickerTitle">选择联系人</h2>
        <button aria-label="关闭" className="suzu-close-button memory-contact-picker__close" disabled={switching} onClick={onClose} type="button">×</button>
      </header>
      <div aria-label="联系人" className="memory-contact-picker__list" role="listbox">
        {contacts.length ? contacts.map((contact) => {
          const id = clean(contact?.id);
          const selected = id === selectedContactId;
          return <button
            aria-selected={selected}
            className={`memory-contact-picker__option${selected ? " is-selected" : ""}`}
            disabled={switching}
            key={id}
            onClick={() => void onSelect(id)}
            role="option"
            type="button"
          >{contactName(contact)}</button>;
        }) : <div className="memory-contact-picker__empty">还没有联系人。</div>}
      </div>
    </aside>
  </div>;
}

function MemoryEditorDialog({ api, contactId, detail, onClose, onError, onSaved, onSuccess }) {
  const memory = detail?.memory;
  const [draft, setDraft] = useState({ content: "", eventDate: "", reason: "", title: "" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setDraft({
      content: memory?.content || "",
      eventDate: memory?.event_date || "",
      reason: "",
      title: memory?.title || "",
    });
  }, [memory?.id, memory?.content, memory?.event_date, memory?.title]);

  if (!memory) return null;

  const save = async (event) => {
    event.preventDefault();
    const content = clean(draft.content);
    if (!content) {
      onError("记忆正文不能为空。");
      return;
    }
    setPending(true);
    onSuccess("正在保存修改并重建关联…");
    try {
      const result = await api.memory.edit(memory.id, {
        title: draft.title,
        eventDate: draft.eventDate,
        content,
      }, draft.reason, { contactId });
      const message = result.embedding?.status === "updated"
        ? "记忆已修改，向量和关联已同步更新。"
        : result.warnings?.[0] || "记忆已修改；当前没有可用向量配置，已使用词面检索。";
      await onSaved();
      onSuccess(message);
      onClose();
    } catch (error) {
      onError(`保存失败：${error?.message || error}`);
    } finally {
      setPending(false);
    }
  };
  const footer = <div className="memory-editor-actions">
    <Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button>
    <Button disabled={pending} form="memoryEditorForm" type="submit">{pending ? "正在保存…" : "保存修改"}</Button>
  </div>;

  return <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title="修改记忆">
    <form className="memory-editor-form" id="memoryEditorForm" onSubmit={save}>
      <label>标题<Input disabled={pending} maxLength="500" onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} type="text" value={draft.title} /></label>
      <label>发生日期<Input disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, eventDate: event.target.value }))} type="date" value={draft.eventDate} /></label>
      <label>记忆正文<Textarea disabled={pending} maxLength={100000} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} required rows={8} value={draft.content} /></label>
      <label>修改说明（可选）<Input disabled={pending} maxLength="1000" onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} placeholder="例如：主体写反了、日期有误" value={draft.reason} /></label>
      <div className="memory-editor-meta"><span>{memoryKindLabel(memory.kind)} · {clean(memory.layer) || "记忆"}</span><span>{detail.sources?.length || 0} 条来源 · {detail.edges?.length || 0} 条关联 · {detail.mutations?.length || 0} 次人工操作</span></div>
    </form>
  </Dialog>;
}

function MemoryLibrary({ api, contactId, onDelete, onEdit, onError, onRestore, onSuccess, refreshToken }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [library, setLibrary] = useState(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setPending(true);
    onSuccess("正在读取记忆库…");
    try {
      const next = await api.memory.list({
        contactId,
        limit: 50,
        query: clean(query),
        statuses: status === "all" ? LIBRARY_STATUSES : [status],
      });
      setLibrary(next);
      onSuccess("");
      return next;
    } catch (error) {
      onError(`读取失败：${error?.message || error}`);
      return null;
    } finally {
      setPending(false);
    }
  }, [api, contactId, onError, onSuccess, query, status]);

  useEffect(() => {
    if (refreshToken > 0) void load();
    // `refreshToken` only changes after an edit dialog succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const loadDetail = async (memoryId) => {
    setPending(true);
    onSuccess("正在读取记忆详情…");
    try {
      const detail = await api.memory.detail(memoryId, { contactId });
      onEdit(detail);
      onSuccess("");
    } catch (error) {
      onError(`读取失败：${error?.message || error}`);
    } finally {
      setPending(false);
    }
  };

  const remove = async (memoryId) => {
    const removed = await onDelete(memoryId);
    if (removed) await load();
  };

  const restore = async (memoryId) => {
    const restored = await onRestore(memoryId);
    if (restored) await load();
  };

  const records = Array.isArray(library?.items) ? library.items : [];
  return <section className="memory-library-card">
    <div className="memory-library-head">
      <div><span className="eyebrow">MEMORY LIBRARY</span><h2>查找和维护记忆</h2></div>
      <span>修改后同步更新向量与关联；删除后不再参与召回</span>
    </div>
    <div className="memory-library-controls">
      <input
        className="search-input"
        disabled={pending}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void load();
          }
        }}
        placeholder="搜索标题或正文"
        type="search"
        value={query}
      />
      <Select
        ariaLabel="记忆状态"
        className="memory-library-status-select"
        disabled={pending}
        onChange={setStatus}
        options={[{ label: "使用中", value: "active" }, { label: "已删除", value: "deleted" }, { label: "全部状态", value: "all" }]}
        value={status}
      />
      <Button disabled={pending} onClick={() => void load()} type="button" variant="secondary">{pending ? "读取中…" : "查记忆库"}</Button>
    </div>
    {!library ? <div className="memory-library-empty">输入关键词可以查找记忆；不输入则查看最近记忆。删除是可恢复的软删除。</div>
      : !records.length ? <div className="memory-library-empty">这个范围内没有找到记忆。</div>
        : <>
          <div className="memory-library-summary">找到 {numberText(library.total)} 条，本页显示 {records.length} 条</div>
          <div className="memory-library-list">
            {records.map((memory) => {
              const deleted = memory.status === "deleted";
              const date = memory.event_date || memory.event_start || "";
              return <article className={`memory-library-item${deleted ? " is-deleted" : ""}`} key={memory.id}>
                <div className="memory-library-item-head">
                  <div><strong>{memory.title || "未命名记忆"}</strong><span>{memoryStatusLabel(memory.status)} · {memoryKindLabel(memory.kind)}{date ? ` · ${date}` : ""}</span></div>
                  <div className="memory-library-actions">
                    <Button disabled={pending} onClick={() => void loadDetail(memory.id)} size="sm" type="button" variant="secondary">修改</Button>
                    {deleted
                      ? <Button disabled={pending} onClick={() => void restore(memory.id)} size="sm" type="button" variant="secondary">恢复</Button>
                      : <Button disabled={pending} onClick={() => void remove(memory.id)} size="sm" type="button" variant="danger">删除</Button>}
                  </div>
                </div>
                <p>{memory.content}</p>
              </article>;
            })}
          </div>
        </>}
  </section>;
}

function BrainDetail({ detail, graph, loading, onDelete, onEdit, selectedNode }) {
  const memory = detail?.memory || selectedNode;
  if (!memory) {
    return <div className="brain-detail-empty"><span className="brain-detail-orb" /><strong>选择一个记忆神经元</strong><p>点击光点后，大脑会将它带到中央并点亮相关记忆。</p></div>;
  }
  const edges = (graph?.edges || []).filter((edge) => edge.source === memory.id || edge.target === memory.id);
  const relations = [...new Set(edges.map((edge) => relationLabel(edge.relation)).filter(Boolean))];
  if (memory.graphNodeType) {
    return <div className="brain-detail-content">
      <span className="eyebrow">SELECTED CONTEXT</span>
      <h2>{memory.title || "记忆上下文"}</h2>
      <p>{memory.preview || "这是一组结构化记忆的共同上下文。"}</p>
      <div className="brain-detail-tags"><span>{visualTierLabel(memory)}</span><span>{memoryKindLabel(memory.kind)}</span><span>{edges.length} 条图谱关联</span></div>
      {relations.length ? <div className="brain-relation-tags">{relations.map((relation) => <span key={relation}>{relation}</span>)}</div> : null}
    </div>;
  }
  return <div className="brain-detail-content">
    <span className="eyebrow">SELECTED MEMORY</span>
    <div className="brain-detail-date">{memoryDate(memory)}</div>
    <h2>{memory.title || "未命名记忆"}</h2>
    <p>{memory.content || memory.preview || (loading ? "正在读取记忆详情…" : "没有可展示的记忆正文")}</p>
    <div className="brain-detail-tags"><span>{visualTierLabel(memory)}</span><span>{memoryKindLabel(memory.kind)}</span>{structureReviewLabel(memory) ? <span>{structureReviewLabel(memory)}</span> : null}<span>{detail ? `${detail.sources?.length || 0} 条原始证据` : `重要度 ${Math.round(Number(memory.importance || 0) * 100)}%`}</span><span>{edges.length} 条记忆关联</span></div>
    {relations.length ? <div className="brain-relation-tags">{relations.map((relation) => <span key={relation}>{relation}</span>)}</div> : null}
    {detail?.memory ? <div className="brain-detail-actions"><Button onClick={() => onEdit(detail)} size="sm" type="button" variant="secondary">修改</Button><Button onClick={() => void onDelete(detail.memory.id)} size="sm" type="button" variant="danger">删除</Button></div> : null}
  </div>;
}

function EvidenceDetail({ source }) {
  if (!source) return null;
  return <div className="brain-detail-content brain-evidence-detail">
    <span className="eyebrow">SOURCE EVIDENCE</span>
    <div className="brain-detail-date">{dateText(source.occurred_at || source.recorded_at || source.known_at)}</div>
    <h2>{clean(source.speaker) || "原始对话"}</h2>
    <p>{clean(source.content) || "这条原文证据没有可显示的正文。"}</p>
    <div className="brain-detail-tags"><span>原文证据</span>{clean(source.source_kind) ? <span>{clean(source.source_kind)}</span> : null}</div>
  </div>;
}

function MemoryBrain({ api, available = true, contactId, onDelete, onEdit, onError, onSuccess, refreshToken = 0 }) {
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selectedEvidence, setSelectedEvidence] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState("");
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const detailRequestRef = useRef(0);

  const loadGraph = useCallback(async () => {
    if (!contactId || !available) {
      setGraph(EMPTY_MEMORY_GRAPH);
      return EMPTY_MEMORY_GRAPH;
    }
    setLoading(true);
    setDetail(null);
    setSelectedEvidence(null);
    setSelectedNode(null);
    try {
      const next = await api.memory.brainGraph({ contactId });
      setGraph(next);
      return next;
    } catch (error) {
      onError(`记忆大脑读取失败：${error?.message || error}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, [api, available, contactId, onError, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    void loadGraph().then((next) => {
      if (cancelled || !next) return;
      onSuccess("");
    });
    return () => {
      cancelled = true;
    };
  }, [loadGraph, onSuccess]);

  useEffect(() => {
    const canvas = canvasRef.current;
    viewerRef.current?.destroy();
    viewerRef.current = null;
    if (!canvas || !graph?.nodes?.length) return undefined;
    let active = true;
    const viewer = createMemoryBrainView(canvas, graph, {
      onReset: () => {
        setSelectedNode(null);
        setDetail(null);
        setSelectedEvidence(null);
        setDetailLoading(false);
      },
      onSelectEvidence: (source) => {
        setSelectedEvidence(source || null);
      },
      onSelect: (node) => {
        const id = clean(node?.id);
        if (!id) return;
        setSelectedNode(node);
        setDetail(null);
        setSelectedEvidence(null);
        const request = ++detailRequestRef.current;
        if (node.graphNodeType) {
          setDetailLoading(false);
          return;
        }
        setDetailLoading(true);
        void api.memory.detail(id, { contactId }).then((next) => {
          if (!active || request !== detailRequestRef.current || viewer.selectedId() !== id) return;
          setDetail(next);
          viewer.setEvidenceSources(id, next?.sources || []);
        }).catch((error) => {
          if (!active || request !== detailRequestRef.current) return;
          onError(`详情读取失败：${error?.message || error}`);
        }).finally(() => {
          if (active && request === detailRequestRef.current) setDetailLoading(false);
        });
      },
    });
    viewerRef.current = viewer;
    return () => {
      active = false;
      viewer.destroy();
      if (viewerRef.current === viewer) viewerRef.current = null;
    };
  }, [api, contactId, graph, onError]);

  const focus = () => {
    const normalized = clean(query).toLocaleLowerCase("zh-CN");
    if (!normalized) {
      onError("先输入要定位的记忆。");
      return;
    }
    const matches = (graph?.nodes || []).filter((node) => (
      `${node.title}\n${node.preview}\n${node.eventDate}`.toLocaleLowerCase("zh-CN").includes(normalized)
    ));
    if (!matches.length) {
      onError("没有找到匹配的记忆神经元。");
      return;
    }
    viewerRef.current?.focusNode(matches[0].id);
    onSuccess(matches.length > 1 ? `找到 ${matches.length} 条，已定位最接近的一条。` : "");
  };

  const remove = async (memoryId) => {
    const removed = await onDelete(memoryId);
    if (removed) await loadGraph();
  };

  const nodeCount = graph?.nodes?.length || 0;
  const edgeCount = graph?.edges?.length || 0;
  const majorCount = graph?.counts?.major ?? graph?.nodes?.filter((node) => node.visualTier === "major").length ?? 0;
  const stateCount = graph?.counts?.state ?? graph?.nodes?.filter((node) => node.visualTier === "state").length ?? 0;
  return <section className="memory-brain-card">
    <div className="memory-brain-toolbar">
      <div><span className="eyebrow">MEMORY BRAIN</span><h2>记忆神经网络</h2></div>
      <div className="memory-brain-stats"><span>{numberText(nodeCount)} 个节点</span><span>{numberText(majorCount)} 个大神经元</span><span>{numberText(stateCount)} 个人物状态</span><span>{numberText(edgeCount)} 条真实关联</span></div>
      <div className="memory-brain-search">
        <input
          className="search-input"
          disabled={!nodeCount || loading}
          list="memoryBrainOptions"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              focus();
            }
          }}
          placeholder="搜索记忆、主题或状态"
          type="search"
          value={query}
        />
        <datalist id="memoryBrainOptions">{(graph?.nodes || []).map((node) => <option key={node.id} value={node.title} />)}</datalist>
        <Button disabled={!nodeCount || loading} onClick={focus} type="button" variant="secondary">定位</Button>
      </div>
    </div>
    <div className="memory-brain-stage">
      <canvas aria-label="可旋转的三维记忆大脑" id="memoryBrainCanvas" ref={canvasRef} tabIndex="0" />
      {loading ? <div className="memory-brain-loading"><span className="brain-loader" /><strong>正在组织记忆空间…</strong></div> : null}
      {!loading && graph && !nodeCount ? <div className="memory-brain-loading"><strong>还没有结构化记忆</strong><span>原始对话不会直接堆进大脑视图。</span></div> : null}
      {selectedNode ? <aside aria-live="polite" className="memory-brain-detail">{selectedEvidence ? <EvidenceDetail source={selectedEvidence} /> : <BrainDetail detail={detail} graph={graph} loading={detailLoading} onDelete={remove} onEdit={onEdit} selectedNode={selectedNode} />}</aside> : null}
      <div className="memory-brain-hint"><span className="brain-legend-major">主题 / 事件簇 / 人物关系</span><span className="brain-legend-state">人物状态</span><span className="brain-legend-minor">具体记忆</span><span>拖动浏览 · 滚轮缩放 · 双击回到全景</span></div>
    </div>
  </section>;
}

function ReviewTags({ omit = [], record }) {
  if (!record || typeof record !== "object") return null;
  const tags = Object.entries(record)
    .filter(([key, value]) => !omit.includes(key) && value !== "" && value !== null && value !== undefined)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value))
    .slice(0, 7);
  if (!tags.length) return null;
  return <div className="memory-review-tags">{tags.map(([key, value]) => <span key={key}>{key}：{plainText(value)}</span>)}</div>;
}

function ReviewMemoryCard({ emptyText = "没有可用的正式记忆", memory }) {
  if (!memory || typeof memory !== "object") return <div className="memory-review-memory-card is-empty">{emptyText}</div>;
  const title = memory.title || memory.kind || memory.id || "未命名记忆";
  const content = memory.content || memory.statement || memory.summary || "没有正文";
  return <article className="memory-review-memory-card">
    <strong>{title}</strong>
    <p>{content}</p>
    <ReviewTags omit={["title", "kind", "id", "content", "statement", "summary", "rationale"]} record={memory} />
  </article>;
}

function ReviewWritePreview({ preview }) {
  if (!preview || typeof preview !== "object") return <ReviewMemoryCard emptyText="没有可展示的写入内容" />;
  const title = preview.title || preview.kind || preview.relation || "候选内容";
  const content = preview.content || preview.statement || preview.rationale
    || (preview.fromMemoryId && preview.toMemoryId ? `${preview.fromMemoryId} → ${preview.toMemoryId}` : "没有正文");
  return <article className="memory-review-memory-card">
    <strong>{title}</strong>
    <p>{content}</p>
    <ReviewTags omit={["title", "kind", "relation", "content", "statement", "rationale"]} record={preview} />
  </article>;
}

function ReviewEvidence({ evidence }) {
  const items = Array.isArray(evidence) ? evidence : [];
  if (!items.length) return <p className="memory-review-empty-inline">没有可展示的直接证据。</p>;
  return <div className="memory-review-evidence-list">{items.map((item, index) => <article className="memory-review-evidence" key={item?.id || item?.sourceId || index}>
    <div><span>{item?.speaker || item?.sourceKind || "来源"}</span><span>{dateText(item?.occurredAt || item?.knownAt)}</span></div>
    <blockquote>{item?.content || item?.statement || "没有可展示的文本"}</blockquote>
    <small>{item?.endpointCoverage || "direct"} · {shortId(item?.id || item?.sourceId)}</small>
  </article>)}</div>;
}

function ReviewMembers({ members }) {
  const items = Array.isArray(members) ? members : [];
  if (!items.length) return null;
  return <section className="memory-review-detail-section">
    <div className="memory-review-section-title"><h3>组成记忆</h3><span>{items.length} 条</span></div>
    <div className="memory-review-member-list">{items.map((item, index) => <article key={item?.memory?.id || item?.id || index}>
      <ReviewMemoryCard emptyText="这条成员记忆当前不可用" memory={item?.memory || item} />
      <details><summary>查看来源</summary><ReviewEvidence evidence={item?.evidence || item?.evidenceSources} /></details>
    </article>)}</div>
  </section>;
}

function ReviewEndpoints({ endpoints }) {
  if (!endpoints || typeof endpoints !== "object") return null;
  return <section className="memory-review-detail-section">
    <div className="memory-review-section-title"><h3>关系端点</h3></div>
    <div className="memory-review-endpoints"><ReviewMemoryCard emptyText="起点已不存在" memory={endpoints.from} /><span>影响 / 导致</span><ReviewMemoryCard emptyText="终点已不存在" memory={endpoints.to} /></div>
  </section>;
}

function MaintenanceFailure({ failure }) {
  if (!failure || typeof failure !== "object") return null;
  const history = Array.isArray(failure.history) ? failure.history : [];
  return <section className="memory-review-detail-section">
    <div className="memory-review-section-title"><h3>维护失败记录</h3><span>{history.length} 次</span></div>
    {history.length ? <div className="memory-review-evidence-list">{history.map((item, index) => <article className="memory-review-evidence" key={`${item?.attempt || index}-${item?.failedAt || ""}`}>
      <div><span>第 {item?.attempt || "?"} 次</span><span>{dateText(item?.failedAt)}</span></div>
      <blockquote>{item?.error || "未记录错误"}</blockquote>
      <details><summary>查看失败参数</summary><pre>{jsonText(item?.details)}</pre></details>
    </article>)}</div> : <p className="memory-review-empty-inline">{failure.lastError || "没有失败历史"}</p>}
  </section>;
}

function ReviewDetail({ detail, onDecide, onRetryLongTermExtraction, pending }) {
  const [note, setNote] = useState("");
  const canDecide = detail.permissions?.canAccept || detail.permissions?.canDismiss || detail.permissions?.canRevoke || detail.permissions?.canRetryLongTermExtraction;
  const humanFallback = ["ingestion", "maintenance-failure"].includes(detail.type);
  return <div className="memory-review-detail">
    <section className="memory-review-detail-section">
      <div className="memory-review-section-title"><h3>{humanFallback ? "人工判断" : "准备写入"}</h3>{humanFallback ? null : <span>置信度 {percentage(detail.confidence)}</span>}</div>
      <ReviewWritePreview preview={detail.writePreview} />
    </section>
    {canDecide ? <div className="memory-review-decision">
      <label>审核备注（可选）<Textarea disabled={pending} onChange={(event) => setNote(event.target.value)} placeholder="记录本次判断理由" rows={2} value={note} /></label>
      <div>
        {detail.permissions?.canDismiss ? <Button disabled={pending} onClick={() => void onDecide("dismiss", note)} type="button" variant="danger">{humanFallback ? "保留基础记忆" : "驳回"}</Button> : null}
        {detail.permissions?.canRetryLongTermExtraction ? <Button disabled={pending} onClick={() => void onRetryLongTermExtraction(note)} type="button" variant="secondary">{pending ? "正在重新提炼…" : "重新提炼"}</Button> : null}
        {detail.permissions?.canAccept ? <Button disabled={pending} onClick={() => void onDecide("accept", note)} type="button">{pending ? "处理中…" : humanFallback ? "人工通过并写入" : "接受并写入"}</Button> : null}
        {detail.permissions?.canRevoke ? <Button disabled={pending} onClick={() => void onDecide("revoke", note)} type="button" variant="danger">撤销关系</Button> : null}
      </div>
    </div> : <p className="memory-review-empty-inline">该审核项已处理，当前仅可查看审计记录。</p>}
    {detail.currentState ? <section className="memory-review-detail-section"><div className="memory-review-section-title"><h3>当前状态</h3></div><div className="memory-review-state-change"><ReviewMemoryCard memory={detail.currentState} /><span>{detail.action || "变更"} →</span><ReviewWritePreview preview={detail.writePreview} /></div></section> : null}
    <ReviewEndpoints endpoints={detail.endpoints} />
    <ReviewMembers members={detail.members} />
    <MaintenanceFailure failure={detail.maintenanceFailure} />
    <section className="memory-review-detail-section"><div className="memory-review-section-title"><h3>直接证据</h3><span>{Array.isArray(detail.evidence) ? detail.evidence.length : 0} 条</span></div><ReviewEvidence evidence={detail.evidence} /></section>
    <details className="memory-review-json"><summary>完整审计记录</summary><pre>{jsonText(detail.proposal)}</pre></details>
  </div>;
}

function ReviewStateBadge({ value }) {
  return <span className={`memory-review-badge is-${clean(value) || "unknown"}`}>{REVIEW_STATE_LABELS[value] || value || "未知"}</span>;
}

function ReviewTypeBadge({ value }) {
  return <span className="memory-review-type">{REVIEW_TYPE_LABELS[value] || value || "未知类型"}</span>;
}

function ReviewItem({ detail, detailError, detailLoading, item, onDecide, onRetryLongTermExtraction, onToggle, pending, selected }) {
  const key = reviewKey(item.type, item.id);
  return <article className="memory-attribution-item memory-review-item">
    <div className="memory-attribution-head">
      <div><span className="eyebrow">{REVIEW_TYPE_LABELS[item.type] || item.type || "REVIEW"} · {dateText(item.createdAt)}</span><h2>{item.title || "未命名候选"}</h2></div>
      <div className="memory-review-badges"><ReviewTypeBadge value={item.type} /><ReviewStateBadge value={item.reviewState} /></div>
    </div>
    <p className="memory-attribution-content">{item.statement || "没有候选正文"}</p>
    <div className="memory-attribution-decision"><span>动作：{item.action || "create"}</span><span>主体：{plainText(item.subjectRole || item.subjectKey || "未指定")}</span><span>置信度：{percentage(item.confidence)}</span></div>
    <div className="memory-review-item-footer"><span>{item.batchId ? `批次 ${shortId(item.batchId)}` : "独立候选"}</span><Button onClick={() => void onToggle(item.type, item.id)} type="button" variant="secondary">{selected ? "收起审核内容" : "查看并审核"}</Button></div>
    {selected ? detailLoading ? <div className="memory-review-detail-loading"><span className="brain-loader" />正在读取候选依据…</div>
      : detailError ? <div className="memory-review-detail-error">{detailError}</div>
        : detail ? <ReviewDetail detail={detail} key={key} onDecide={onDecide} onRetryLongTermExtraction={onRetryLongTermExtraction} pending={pending} /> : null : null}
  </article>;
}

function ReviewHealthItem({ body, title, tone = "" }) {
  return <article className={`memory-review-health-item${tone ? ` is-${tone}` : ""}`}><strong>{title}</strong><p>{body || "没有待处理项"}</p></article>;
}

function PipelineHealth({ onRecover, overview, recovering }) {
  const pipeline = overview?.pipeline || {};
  const blocked = pipeline.blockedEvents?.items || [];
  const active = pipeline.activeBatches || [];
  const failed = pipeline.failedBatches || [];
  const maintenance = overview?.maintenance?.tasks || [];
  return <details className="memory-review-health">
    <summary>处理状态 <span>阻塞 {numberText(overview?.counts?.blockedEvents)} · 异常 {numberText(overview?.counts?.failedMaintenance)}</span></summary>
    <div className="memory-review-health-grid">
      <ReviewHealthItem body={blocked.length ? blocked.map((item) => `${item.external_id || item.id}：${item.last_error || "等待处理"}`).join("\n") : "没有卡住的输入事件"} title="阻塞输入" tone={blocked.length ? "warning" : ""} />
      <article className="memory-review-health-item"><strong>输入批次</strong>{active.length ? active.map((batch) => <div className="memory-review-batch" key={batch.id}><span>{shortId(batch.id)} · {batch.leaseExpired ? "租约已过期" : "处理中"}</span>{batch.leaseExpired ? <Button disabled={recovering === batch.id} onClick={() => void onRecover(batch.id)} size="sm" type="button" variant="secondary">{recovering === batch.id ? "恢复中…" : "恢复批次"}</Button> : null}</div>) : <p>没有运行中的输入批次</p>}</article>
      <ReviewHealthItem body={failed.length ? failed.map((item) => `${item.id || "未命名批次"}：${item.error_message || "未记录失败原因"}`).join("\n") : "没有失败批次"} title="失败批次" tone={failed.length ? "warning" : ""} />
      <ReviewHealthItem body={maintenance.length ? maintenance.map((item) => `${item.task_type} · ${item.status}${item.error_message ? `：${item.error_message}` : ""}`).join("\n") : "没有等待或失败的维护任务"} title="维护任务" tone={maintenance.length ? "warning" : ""} />
    </div>
  </details>;
}

function StorageHealth({ backingUp, onBackup, onRestore, overview, restoring }) {
  const storage = overview?.storage || {};
  const active = storage.activeDatabase || {};
  const backups = storage.backups || {};
  const latest = backups.latest || {};
  return <details className="memory-review-health">
    <summary>存储健康 <span>{active.status === "valid" ? "运行库正常" : "运行库待检查"} · {backups.status === "valid" ? "备份正常" : backups.status === "missing" ? "尚无备份" : "备份异常"}</span></summary>
    <div className="memory-review-storage">
      <div><strong>当前记忆数据库</strong><p>状态：{active.status || "unknown"}<br />位置：{active.databasePath || "—"}</p></div>
      <div><strong>数据库备份</strong><p>数量：{numberText(backups.total)}<br />最新：{latest.createdAt || latest.modifiedAt || "—"}</p></div>
      <div className="memory-review-storage-actions">
        <Button disabled={backingUp || restoring} onClick={() => void onBackup()} type="button" variant="secondary">{backingUp ? "正在创建…" : "创建备份"}</Button>
        <Button disabled={backingUp || restoring} onClick={() => void onRestore()} type="button" variant="secondary">{restoring ? "正在恢复…" : "恢复备份"}</Button>
      </div>
    </div>
  </details>;
}

function MemoryReview({ actions, api, contactId, onError, onSuccess, refreshToken = 0 }) {
  const [type, setType] = useState("all");
  const [reviewState, setReviewState] = useState("pending");
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [details, setDetails] = useState({});
  const [detailErrors, setDetailErrors] = useState({});
  const [selectedKey, setSelectedKey] = useState("");
  const [detailLoadingKey, setDetailLoadingKey] = useState("");
  const [resolvingKey, setResolvingKey] = useState("");
  const [recoveringBatch, setRecoveringBatch] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const overviewRequestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++overviewRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.memory.reviewOverview({
        contactId,
        limit: 100,
        reviewStates: [reviewState],
        types: type === "all" ? REVIEW_TYPES.filter(([value]) => value !== "all").map(([value]) => value) : [type],
      });
      if (request !== overviewRequestRef.current) return null;
      setOverview(next);
      return next;
    } catch (loadError) {
      if (request === overviewRequestRef.current) {
        const message = loadError?.message || String(loadError);
        setError(message);
        onError(`读取审核队列失败：${message}`);
      }
      return null;
    } finally {
      if (request === overviewRequestRef.current) setLoading(false);
    }
  }, [api, contactId, onError, refreshToken, reviewState, type]);

  useEffect(() => {
    void load();
    return () => {
      overviewRequestRef.current += 1;
    };
  }, [load]);

  const chooseType = (next) => {
    if (next === type) return;
    setSelectedKey("");
    setDetails({});
    setDetailErrors({});
    setType(next);
  };
  const chooseState = (next) => {
    if (next === reviewState) return;
    setSelectedKey("");
    setDetails({});
    setDetailErrors({});
    setReviewState(next);
  };

  const toggleDetail = async (proposalType, proposalId) => {
    const key = reviewKey(proposalType, proposalId);
    if (!proposalType || !proposalId) return;
    if (selectedKey === key) {
      setSelectedKey("");
      return;
    }
    setSelectedKey(key);
    if (details[key]) return;
    setDetailLoadingKey(key);
    setDetailErrors((current) => ({ ...current, [key]: "" }));
    try {
      const detail = await api.memory.reviewProposal(proposalType, proposalId, { contactId });
      setDetails((current) => ({ ...current, [key]: detail }));
    } catch (detailError) {
      const message = detailError?.message || String(detailError);
      setDetailErrors((current) => ({ ...current, [key]: message }));
      onError(`读取审核依据失败：${message}`);
    } finally {
      setDetailLoadingKey("");
    }
  };

  const decide = async (detail, action, note) => {
    const key = reviewKey(detail.type, detail.id);
    const confirmation = action === "accept"
      ? "接受后会把候选写入正式长期记忆。确定内容、当前状态和证据都正确吗？"
      : action === "revoke"
        ? "撤销后这条关系将不再参与记忆检索。确定撤销吗？"
        : "";
    if (confirmation && !window.confirm(confirmation)) return;
    setResolvingKey(key);
    onSuccess(action === "accept" ? "正在写入审核结果…" : action === "revoke" ? "正在撤销关系…" : "正在驳回候选…");
    try {
      if (action === "revoke") {
        await api.memory.revokeReviewRelation(detail.id, note, { contactId });
      } else {
        await api.memory.resolveReview(detail.type, detail.id, action, note, { contactId });
      }
      setSelectedKey("");
      setDetails({});
      setDetailErrors({});
      await Promise.all([actions.refreshStatus?.(), load()]);
      onSuccess(action === "accept" ? "候选已接受并写入正式长期记忆。" : action === "revoke" ? "关系已撤销。" : "候选已驳回，正式记忆未修改。");
    } catch (decisionError) {
      onError(`审核失败：${decisionError?.message || decisionError}`);
    } finally {
      setResolvingKey("");
    }
  };

  const retryLongTermExtraction = async (detail, note) => {
    const key = reviewKey(detail.type, detail.id);
    if (!window.confirm("会从已保留的原文证据重新提炼长期记忆，并保留本次审核记录。确定继续吗？")) return;
    setResolvingKey(key);
    onSuccess("正在从原文证据重新提炼长期记忆…");
    try {
      const result = await api.memory.retryLongTermExtractionReview(detail.id, note, { contactId });
      setSelectedKey("");
      setDetails({});
      setDetailErrors({});
      await Promise.all([actions.refreshStatus?.(), load()]);
      onSuccess(result?.status === "retried" ? "原文已重新提炼，新的候选已进入审核。" : "重新提炼未完成，原文证据与审核项已保留。请查看失败原因。");
    } catch (retryError) {
      onError(`重新提炼失败：${retryError?.message || retryError}`);
    } finally {
      setResolvingKey("");
    }
  };

  const recover = async (batchId) => {
    setRecoveringBatch(batchId);
    onSuccess("正在恢复过期输入批次…");
    try {
      const result = await api.memory.recoverReviewInputBatch(batchId, false, { contactId });
      await load();
      onSuccess(`已恢复 ${numberText(result?.recovered)} 个过期批次。`);
    } catch (recoverError) {
      onError(`恢复批次失败：${recoverError?.message || recoverError}`);
    } finally {
      setRecoveringBatch("");
    }
  };

  const backup = async () => {
    setBackingUp(true);
    onSuccess("正在创建并校验记忆备份…");
    try {
      await api.memory.createReviewBackup({ contactId });
      await load();
      onSuccess("记忆数据库备份已创建并校验。");
    } catch (backupError) {
      onError(`创建备份失败：${backupError?.message || backupError}`);
    } finally {
      setBackingUp(false);
    }
  };

  const restoreBackup = async () => {
    setRestoring(true);
    try {
      const selected = await api.memory.selectReviewBackup();
      if (selected?.canceled || !clean(selected?.sourcePath)) return;
      const inspection = await api.memory.inspectReviewBackup(selected.sourcePath, { contactId });
      const size = Number(inspection?.bytes || 0);
      const summary = `${inspection?.createdAt || "未记录创建时间"} · ${size ? `${Math.max(1, Math.round(size / 1024))} KB` : "大小未知"}`;
      if (!window.confirm(`恢复会覆盖当前联系人的记忆数据库；恢复前会自动创建一份安全备份。\n\n备份：${summary}\n\n确定恢复吗？`)) return;
      onSuccess("正在恢复并校验记忆备份…");
      await api.memory.restoreReviewBackup(selected.sourcePath, { contactId });
      await Promise.all([actions.refreshStatus?.(), load()]);
      onSuccess("记忆备份已恢复，并已创建恢复前安全备份。");
    } catch (restoreError) {
      onError(`恢复备份失败：${restoreError?.message || restoreError}`);
    } finally {
      setRestoring(false);
    }
  };

  const items = Array.isArray(overview?.reviews?.items) ? overview.reviews.items : [];
  return <section className="memory-attribution-card memory-review-card">
    <div className="memory-attribution-intro"><div><span className="eyebrow">MEMORY REVIEW</span><h2>审核中心</h2></div><p>候选不会直接进入正式长期记忆；在这里核对内容、现有状态和直接证据后再决定。</p></div>
    <div className="memory-review-filters">
      <div><span>候选类型</span>{REVIEW_TYPES.map(([value, label]) => <Button aria-pressed={type === value} className={`memory-mode-action${type === value ? " is-active" : ""}`} key={value} onClick={() => chooseType(value)} type="button" variant="secondary">{label}</Button>)}</div>
      <div><span>审核状态</span>{REVIEW_STATES.map(([value, label]) => <Button aria-pressed={reviewState === value} className={`memory-mode-action${reviewState === value ? " is-active" : ""}`} key={value} onClick={() => chooseState(value)} type="button" variant="secondary">{label}</Button>)}</div>
    </div>
    {loading ? <div className="memory-attribution-empty"><span className="brain-loader" /><strong>正在读取审核队列</strong></div>
      : error ? <div className="memory-attribution-empty"><strong>读取失败</strong><span>{error}</span></div>
        : !overview ? <div className="memory-attribution-empty">打开审核中心后会读取本机记忆的当前审核队列。</div>
          : <>
            <div className="memory-review-metrics"><article><span>等待审核</span><strong>{numberText(overview.counts?.reviews)}</strong></article><article><span>阻塞事件</span><strong>{numberText(overview.counts?.blockedEvents)}</strong></article><article><span>运行批次</span><strong>{numberText(overview.counts?.activeBatches)}</strong><small>{numberText(overview.counts?.expiredBatches)} 个租约已过期</small></article><article><span>维护异常</span><strong>{numberText(overview.counts?.failedMaintenance)}</strong><small>{numberText(overview.counts?.pendingMaintenance)} 个等待执行</small></article></div>
            {items.length ? <div className="memory-attribution-list memory-review-list">{items.map((item) => {
              const key = reviewKey(item.type, item.id);
              return <ReviewItem detail={details[key]} detailError={detailErrors[key]} detailLoading={detailLoadingKey === key} item={item} key={key} onDecide={(action, note) => decide(details[key], action, note)} onRetryLongTermExtraction={(note) => retryLongTermExtraction(details[key], note)} onToggle={toggleDetail} pending={resolvingKey === key} selected={selectedKey === key} />;
            })}</div> : <div className="memory-attribution-empty"><strong>当前筛选条件下没有候选</strong><span>可以切换审核状态查看已经处理的记录。</span></div>}
            <PipelineHealth onRecover={recover} overview={overview} recovering={recoveringBatch} />
            <StorageHealth backingUp={backingUp} onBackup={backup} onRestore={restoreBackup} overview={overview} restoring={restoring} />
          </>}
  </section>;
}

export function MemoryPage({ actions = {}, api, loading = false, snapshot = {} }) {
  const memory = snapshot.memory || {};
  const contacts = Array.isArray(memory.contacts) ? memory.contacts : [];
  const contactId = clean(memory.selectedContactId);
  const ready = memory.status === "ready";
  const selectedContact = memory.selectedContact || contacts.find((contact) => clean(contact?.id) === contactId) || null;
  const [view, setView] = useState("brain");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [contactPending, setContactPending] = useState(false);
  const [editing, setEditing] = useState(null);
  const [memoryRefreshToken, setMemoryRefreshToken] = useState(0);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    setView("brain");
    setContactPickerOpen(false);
    setEditing(null);
    setImportDialogOpen(false);
    setPageError("");
  }, [contactId]);

  const reportError = useCallback((message) => {
    const text = clean(message) || "无法完成这项记忆操作。";
    setPageError(text);
    actions.setNotice?.(text);
  }, [actions.setNotice]);

  const reportSuccess = useCallback((message = "") => {
    setPageError("");
    actions.setNotice?.(message);
  }, [actions.setNotice]);

  const selectContact = async (nextContactId) => {
    const id = clean(nextContactId);
    if (!id || contactPending || loading) return;
    if (id === contactId) {
      setContactPickerOpen(false);
      return;
    }
    setContactPending(true);
    setContactPickerOpen(false);
    setPageError("");
    try {
      await actions.selectContact?.(id);
    } catch (error) {
      reportError(`切换联系人记忆失败：${error?.message || error}`);
    } finally {
      setContactPending(false);
    }
  };

  const setRecallEnabled = async (nextEnabled) => {
    if (loading) return;
    setPageError("");
    try {
      await actions.setRecallEnabled?.(Boolean(nextEnabled));
    } catch (error) {
      reportError(`无法更新记忆召回开关：${error?.message || error}`);
    }
  };

  const refreshStatus = async () => {
    await actions.refreshStatus?.();
  };

  const importMemoryDatabase = async () => {
    if (!contactId || importing || loading) return;
    setImporting(true);
    try {
      const selected = await api.memory.selectImportDatabase();
      if (selected?.canceled || !clean(selected?.sourcePath)) return;
      const inspection = await api.memory.inspectImportDatabase(selected.sourcePath, { contactId });
      const size = Number(inspection?.bytes || 0);
      const agentScopes = Array.isArray(inspection?.agentIds) ? inspection.agentIds.filter(Boolean) : [];
      const sourceSummary = `${size ? `${Math.max(1, Math.round(size / 1024))} KB` : "大小未知"}${agentScopes.length ? ` · ${agentScopes.length} 个 Agent 范围` : " · 未记录 Agent 范围"}`;
      const targetName = contactName(selectedContact);
      if (!window.confirm(`导入会覆盖「${targetName}」当前的记忆数据库；导入前会自动创建一份安全备份。\n\n来源：${sourceSummary}\n\n数据库内的 Agent 标识会自动绑定到「${targetName}」。源文件不会被修改。\n\n确定导入吗？`)) return;
      reportSuccess("正在导入、重绑并校验记忆数据库…");
      await api.memory.importDatabase(selected.sourcePath, { contactId });
      await refreshStatus();
      setMemoryRefreshToken((current) => current + 1);
      reportSuccess(`已导入「${targetName}」的记忆，并创建导入前安全备份。`);
    } catch (importError) {
      reportError(`导入记忆失败：${importError?.message || importError}`);
    } finally {
      setImporting(false);
    }
  };

  const confirmMemoryImport = () => {
    if (!contactId || importing || loading) return;
    setImportDialogOpen(false);
    void importMemoryDatabase();
  };

  const deleteMemory = async (memoryId) => {
    if (!memoryId) return false;
    if (!window.confirm("删除后这条记忆将立即退出召回和关联链。仍可在“已删除”中恢复。确定删除吗？")) return false;
    reportSuccess("正在删除记忆…");
    try {
      await api.memory.remove(memoryId, "", { contactId });
      await refreshStatus();
      reportSuccess("记忆已删除，可在“已删除”中恢复。");
      return true;
    } catch (error) {
      reportError(`删除失败：${error?.message || error}`);
      return false;
    }
  };

  const restoreMemory = async (memoryId) => {
    if (!memoryId) return false;
    reportSuccess("正在恢复记忆和关联…");
    try {
      await api.memory.restore(memoryId, "", { contactId });
      await refreshStatus();
      reportSuccess("记忆已恢复。");
      return true;
    } catch (error) {
      reportError(`恢复失败：${error?.message || error}`);
      return false;
    }
  };

  const openEdit = (detail) => {
    if (!detail?.memory) return;
    setEditing(detail);
  };

  const finishEdit = async () => {
    await refreshStatus();
    setMemoryRefreshToken((current) => current + 1);
  };

  const visibleView = ["brain", "library", "review"].includes(view) ? view : "brain";
  const recallEnabled = snapshot.settings?.memoryRecallEnabled !== false;
  const selectView = (nextView) => {
    if (loading || (!ready && nextView !== "brain")) return;
    setView(nextView);
  };
  const apiConnections = Array.isArray(snapshot?.apiServices?.connections) ? snapshot.apiServices.connections : [];
  const apiBindings = snapshot?.apiServices?.bindings && typeof snapshot.apiServices.bindings === "object" ? snapshot.apiServices.bindings : {};
  const memoryEmbeddingTypes = API_BINDINGS.find((item) => item.id === "memory-embedding")?.types || [];
  const memoryEmbeddingConnections = apiConnections.filter((item) => memoryEmbeddingTypes.includes(item.type));
  const headerActions = <div className="memory-page-actions">
    <Button aria-expanded={contactPickerOpen} aria-haspopup="dialog" className={`memory-contact-picker-trigger${contactPickerOpen ? " is-active" : ""}`} disabled={!contacts.length || loading || contactPending} onClick={() => setContactPickerOpen((current) => !current)} type="button" variant="secondary">联系人：{contactName(selectedContact)}</Button>
    <Button disabled={!contactId || loading || importing} onClick={() => setImportDialogOpen(true)} type="button" variant="secondary">{importing ? "正在导入…" : "导入记忆"}</Button>
    <ApiConnectionPicker
      connections={memoryEmbeddingConnections}
      onManage={actions.openApiServices}
      onSelect={(connectionId) => actions.selectApiBinding?.("memory-embedding", connectionId)}
      selectedId={apiBindings["memory-embedding"] || ""}
      title="为记忆向量选择 API"
    />
    <div className="memory-recall-control"><span id="memoryRecallLabel">记忆召回</span><Switch aria-labelledby="memoryRecallLabel" checked={recallEnabled} disabled={loading} onChange={(event) => void setRecallEnabled(event.target.checked)} /></div>
    <Tabs active={visibleView} className="memory-view-tabs" items={MEMORY_VIEW_TABS} onChange={selectView} size="sm" />
    <Button onClick={actions.returnToOverview} type="button" variant="secondary">返回关系</Button>
  </div>;

  return <div className="memory-react-page">
    <PageHeader
      action={headerActions}
      eyebrow="RELATIONSHIPS / MEMORY"
      subtitle="查看长期记忆、测试召回，并维护结构化事件之间的联系。"
      title="记忆"
    />
    <ContactPicker contacts={contacts} onClose={() => setContactPickerOpen(false)} onSelect={selectContact} open={contactPickerOpen} selectedContactId={contactId} switching={loading || contactPending} />
    <Dialog
      footer={<div className="memory-import-dialog-actions"><Button onClick={() => setImportDialogOpen(false)} type="button" variant="secondary">取消</Button><Button onClick={confirmMemoryImport} type="button">选择 .db 文件</Button></div>}
      onClose={() => setImportDialogOpen(false)}
      open={importDialogOpen}
      title="导入 Suzu Memory 记忆"
    >
      <div className="memory-import-dialog-copy">
        <p>请选择由 Suzu Memory 创建的 <code>.db</code> 记忆数据库。</p>
        <p>不要选择其他软件的普通数据库；导入时会检查数据库结构和其中唯一的 Agent 范围。</p>
        <p>导入会覆盖「{contactName(selectedContact)}」当前的记忆库，但会先创建安全备份，源文件不会被修改。</p>
      </div>
    </Dialog>
    {pageError ? <Banner className="memory-page-error" tone="danger">{pageError}</Banner> : null}
    {!contactId && !contacts.length ? <GlassPanel as="section" className="memory-page-empty" intensity="soft"><Empty description="先在关系页创建一位联系人，再为对方建立长期记忆。" title="还没有联系人" /></GlassPanel>
      : visibleView === "brain" ? <MemoryBrain api={api} available={ready} contactId={contactId} onDelete={deleteMemory} onEdit={(detail) => {
        setView("library");
        openEdit(detail);
      }} onError={reportError} onSuccess={reportSuccess} refreshToken={memoryRefreshToken} />
        : visibleView === "review" ? <MemoryReview actions={{ refreshStatus }} api={api} contactId={contactId} onError={reportError} onSuccess={reportSuccess} refreshToken={memoryRefreshToken} />
          : <>
            <MemoryOverview api={api} contactId={contactId} memory={memory} onError={reportError} onSuccess={reportSuccess} />
            <MemoryLibrary api={api} contactId={contactId} onDelete={deleteMemory} onEdit={openEdit} onError={reportError} onRestore={restoreMemory} onSuccess={reportSuccess} refreshToken={memoryRefreshToken} />
          </>}
    <MemoryEditorDialog api={api} contactId={contactId} detail={editing} onClose={() => setEditing(null)} onError={reportError} onSaved={finishEdit} onSuccess={reportSuccess} />
  </div>;
}
