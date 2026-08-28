import { useCallback, useEffect, useRef, useState } from "react";
import { Input, Select } from "suzu-design-system";
import { createPortal } from "react-dom";

import { releasePointerCapture } from "../core/pointer-capture.mjs";
import {
  conversationMessageBlocks,
  mergeConversationMessageWindow,
  mergeConversationMessages,
  projectedLiveReply,
} from "../features/conversation/index.mjs";
import { ConversationMessageList } from "./conversation-page.jsx";
import { usePointerCaptureRecovery } from "./pointer-capture-recovery.mjs";
import "./software-assistant-dialog.css";

const SOFTWARE_ASSISTANT_PANEL_DEFAULT_WIDTH = 480;
const SOFTWARE_ASSISTANT_PANEL_MIN_WIDTH = 380;
const SOFTWARE_ASSISTANT_PANEL_MAX_WIDTH = 720;
const SOFTWARE_ASSISTANT_REASONING_EFFORT_OPTIONS = Object.freeze([
  { label: "关闭", value: "off" },
  { label: "低", value: "low" },
  { label: "高", value: "high" },
  { label: "最大", value: "max" },
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePanelWidth(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return SOFTWARE_ASSISTANT_PANEL_DEFAULT_WIDTH;
  return Math.min(Math.max(numeric, SOFTWARE_ASSISTANT_PANEL_MIN_WIDTH), SOFTWARE_ASSISTANT_PANEL_MAX_WIDTH);
}

function normalizeReasoningEffort(value) {
  const effort = clean(value);
  return SOFTWARE_ASSISTANT_REASONING_EFFORT_OPTIONS.some((option) => option.value === effort) ? effort : "high";
}

function textBlocks(message) {
  return (Array.isArray(message?.blocks) ? message.blocks : [])
    .filter((block) => clean(block?.kind || "text") === "text" && clean(block?.text))
    .map((block) => clean(block.text));
}

function transcriptBlocks(message) {
  return (Array.isArray(message?.blocks) ? message.blocks : []).filter((block) => {
    const kind = clean(block?.kind);
    if (kind === "text") return Boolean(clean(block?.text));
    return ["media", "tool_result", "tool_use"].includes(kind);
  });
}

function displayMessages(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const sourceKind = clean(message?.kind);
    const blocks = transcriptBlocks(message);
    if (!blocks.length || !["user", "assistant", "system"].includes(sourceKind)) return [];
    return [{
      blocks,
      id: clean(message?.id) || `${sourceKind}:${textBlocks(message).join("\n").slice(0, 80)}`,
      kind: sourceKind === "system" ? "assistant" : sourceKind,
      lineNumber: Number.isSafeInteger(Number(message?.lineNumber)) ? Number(message.lineNumber) : 0,
      timestamp: clean(message?.timestamp),
    }];
  });
}

const INTRODUCTION = "我可以帮你找到软件功能、直接切换已支持的设置，或一步步说明 API 和能力该怎么配置。";

function avatarInitial(value, fallback = "") {
  const text = clean(value) || fallback;
  return Array.from(text)[0] || "我";
}

function conversationRow(message, owner, { live = false } = {}) {
  const kind = clean(message?.kind) === "user" ? "user" : "assistant";
  const text = textBlocks(message);
  const blocks = conversationMessageBlocks(message);
  const id = clean(message?.id) || `${kind}:${text.join("\n").slice(0, 80)}`;
  const ownerName = clean(owner?.displayName) || "我";
  const ownerAvatar = clean(owner?.avatarDataUrl);
  return {
    entering: Boolean(message?.animateIn),
    type: "message",
    kind,
    sourceMessageId: id,
    live: live || Boolean(message?.pending || message?.streaming),
    avatar: kind === "assistant"
      ? { src: "./app-icon.png", initial: "S" }
      : { src: ownerAvatar, initial: avatarInitial(ownerName, "我") },
    blocks,
  };
}

/**
 * A persistent non-modal panel for the fixed product-help Agent Core session.
 * It intentionally owns none of the contact conversation UI or its memory.
 */
export function SoftwareAssistantDialog({ api, initialPrompt = "", onClose, onPanelWidthChange, onPromptConsumed, onReasoningEffortChange, open = false, owner = null, panelWidth = SOFTWARE_ASSISTANT_PANEL_DEFAULT_WIDTH, reasoningEffort = "high" }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [pendingMessages, setPendingMessages] = useState([]);
  const [liveReplies, setLiveReplies] = useState(() => new Map());
  const [sessionId, setSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [resizing, setResizing] = useState(false);
  const [savingReasoningEffort, setSavingReasoningEffort] = useState(false);
  const [visiblePanelWidth, setVisiblePanelWidth] = useState(() => normalizePanelWidth(panelWidth));
  const actionsRef = useRef(null);
  const composerRef = useRef(null);
  const historyRef = useRef(null);
  const panelResizeRef = useRef(null);
  const panelWidthRef = useRef(normalizePanelWidth(panelWidth));
  const processedPromptRef = useRef("");
  const activeRequestRef = useRef("");
  // A history snapshot is asynchronous while turn events can continue to
  // arrive.  Keep the visible transcript monotonic: a late, shorter snapshot
  // must never replace rows the person has already seen.
  const historyEpochRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const appliedRefreshSequenceRef = useRef(0);

  useEffect(() => {
    if (panelResizeRef.current) return;
    const nextWidth = normalizePanelWidth(panelWidth);
    panelWidthRef.current = nextWidth;
    setVisiblePanelWidth(nextWidth);
  }, [panelWidth]);

  const applyPanelWidth = useCallback((value) => {
    const nextWidth = normalizePanelWidth(value);
    panelWidthRef.current = nextWidth;
    setVisiblePanelWidth(nextWidth);
    return nextWidth;
  }, []);

  const panelWidthFromPointer = useCallback((clientX, activeResize) => (
    normalizePanelWidth(activeResize.startWidth + activeResize.startX - clientX)
  ), []);

  const finishPanelResize = useCallback((event, { applyPointer = true, save = true } = {}) => {
    const activeResize = panelResizeRef.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    if (applyPointer && Number.isFinite(event.clientX)) applyPanelWidth(panelWidthFromPointer(event.clientX, activeResize));
    panelResizeRef.current = null;
    setResizing(false);
    releasePointerCapture(event.currentTarget || activeResize.target, activeResize.pointerId);
    if (save) void onPanelWidthChange?.(panelWidthRef.current);
  }, [applyPanelWidth, onPanelWidthChange, panelWidthFromPointer]);

  const beginPanelResize = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    panelResizeRef.current = {
      pointerId: event.pointerId,
      startWidth: panelWidthRef.current,
      startX: event.clientX,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizing(true);
  }, []);

  const resizePanel = useCallback((event) => {
    const activeResize = panelResizeRef.current;
    if (activeResize?.pointerId !== event.pointerId) return;
    applyPanelWidth(panelWidthFromPointer(event.clientX, activeResize));
  }, [applyPanelWidth, panelWidthFromPointer]);

  const cancelPanelResize = useCallback((event) => {
    const activeResize = panelResizeRef.current;
    if (activeResize?.pointerId !== event.pointerId) return;
    applyPanelWidth(activeResize.startWidth);
    finishPanelResize(event, { applyPointer: false, save: false });
  }, [applyPanelWidth, finishPanelResize]);

  const abortPanelResize = useCallback(() => {
    const activeResize = panelResizeRef.current;
    if (!activeResize) return;
    panelResizeRef.current = null;
    setResizing(false);
    releasePointerCapture(activeResize.target, activeResize.pointerId);
  }, []);

  usePointerCaptureRecovery(abortPanelResize);

  const resizePanelFromKeyboard = useCallback((event) => {
    let nextWidth = null;
    if (event.key === "ArrowLeft") nextWidth = panelWidthRef.current + 24;
    if (event.key === "ArrowRight") nextWidth = panelWidthRef.current - 24;
    if (event.key === "Home") nextWidth = SOFTWARE_ASSISTANT_PANEL_MIN_WIDTH;
    if (event.key === "End") nextWidth = SOFTWARE_ASSISTANT_PANEL_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    const normalized = applyPanelWidth(nextWidth);
    void onPanelWidthChange?.(normalized);
  }, [applyPanelWidth, onPanelWidthChange]);

  const invalidateHistoryRefreshes = useCallback(() => {
    historyEpochRef.current += 1;
    appliedRefreshSequenceRef.current = ++refreshSequenceRef.current;
  }, []);

  const refresh = useCallback(async () => {
    if (typeof api?.snapshot !== "function") {
      setError("当前版本没有连接到 Suzu 使用助手。");
      return null;
    }
    const historyEpoch = historyEpochRef.current;
    const refreshSequence = ++refreshSequenceRef.current;
    try {
      const snapshot = await api.snapshot();
      if (historyEpoch !== historyEpochRef.current || refreshSequence < appliedRefreshSequenceRef.current) {
        return snapshot;
      }
      appliedRefreshSequenceRef.current = refreshSequence;
      if (snapshot?.status === "ready") {
        const incoming = displayMessages(snapshot.messages);
        setMessages((current) => mergeConversationMessageWindow(current, incoming).messages);
        setSessionId(clean(snapshot.sessionId));
        setError("");
        // A snapshot can have started before the local send promise returned.
        // Do not let that older `running: false` observation make the composer
        // look idle while this dialog already owns an active request.
        setPhase((current) => {
          if (snapshot.running === true) return "thinking";
          return activeRequestRef.current ? current : "idle";
        });
        return snapshot;
      }
      setError(clean(snapshot?.error) || "软件助手暂时无法启动。请先检查主模型设置。");
      return snapshot;
    } catch (cause) {
      setError(`无法读取软件助手：${clean(cause?.message || cause) || "未知错误。"}`);
      return null;
    }
  }, [api]);

  const send = useCallback(async (raw) => {
    const text = clean(raw);
    if (!text) return false;
    if (!sessionId) {
      setError("Suzu 正在启动，请稍后再试。");
      return false;
    }
    if (typeof api?.send !== "function") {
      setError("当前版本没有连接到 Suzu 使用助手。");
      return false;
    }
    const pending = {
      accepted: false,
      animateIn: true,
      content: text,
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      media: [],
      queued: false,
      queuePosition: 0,
      requestId: "",
      sessionId,
      timestamp: new Date().toISOString(),
    };
    setPendingMessages((current) => [...current, pending]);
    setDraft("");
    setError("");
    setPhase("thinking");
    try {
      const result = await api.send({ content: text });
      activeRequestRef.current = clean(result?.requestId);
      if (result?.accepted !== true) throw new Error("软件助手没有接受这条问题。");
      const acceptedSessionId = clean(result?.sessionId) || sessionId;
      setSessionId(acceptedSessionId);
      setPendingMessages((current) => current.map((item) => (
        item.id === pending.id
          ? {
            ...item,
            accepted: true,
            queued: result?.queued === true,
            requestId: activeRequestRef.current,
            sessionId: acceptedSessionId,
            steering: result?.steering === true,
          }
          : item
      )));
      return true;
    } catch (cause) {
      setPendingMessages((current) => current.filter((item) => item.id !== pending.id));
      setPhase("idle");
      setError(`无法发送：${clean(cause?.message || cause) || "未知错误。"}`);
      return false;
    }
  }, [api, sessionId]);

  const projectLiveReply = useCallback((event, { final = false } = {}) => {
    const requestId = clean(event?.requestId) || activeRequestRef.current;
    const replySessionId = clean(event?.sessionId) || sessionId;
    if (!requestId || !replySessionId) return;
    setSessionId(replySessionId);
    setLiveReplies((current) => {
      const next = new Map(current);
      next.set(requestId, projectedLiveReply(next.get(requestId), {
        ...event,
        requestId,
        sessionId: replySessionId,
      }, { final }));
      return next;
    });
  }, [sessionId]);

  const stop = useCallback(async () => {
    if (!["thinking", "replying"].includes(phase) || typeof api?.stop !== "function") return;
    try {
      await api.stop({ requestId: activeRequestRef.current });
    } catch (cause) {
      setError(`无法停止：${clean(cause?.message || cause) || "未知错误。"}`);
    }
  }, [api, phase]);

  const clearHistory = useCallback(async () => {
    if (phase !== "idle") return false;
    if (typeof api?.clearHistory !== "function") {
      setError("当前版本没有连接到问 Suzu 的记录清理功能。");
      return false;
    }
    if (!window.confirm("会清空“问 Suzu”过往的对话与工具记录，下一次提问将从新的会话开始。\n\n联系人聊天、联系人资料和软件设置不会受影响。确定清空吗？")) return false;
    setError("");
    setPhase("clearing");
    try {
      const result = await api.clearHistory();
      if (result?.cleared !== true) throw new Error("软件助手记录没有被清空。");
      activeRequestRef.current = "";
      invalidateHistoryRefreshes();
      setMessages([]);
      setPendingMessages([]);
      setLiveReplies(new Map());
      setSessionId("");
      await refresh();
      return true;
    } catch (cause) {
      setError(`无法清空记录：${clean(cause?.message || cause) || "未知错误。"}`);
      return false;
    } finally {
      setPhase("idle");
    }
  }, [api, invalidateHistoryRefreshes, phase, refresh]);

  const changeReasoningEffort = useCallback(async (value) => {
    const nextEffort = normalizeReasoningEffort(value);
    if (phase !== "idle" || savingReasoningEffort) return false;
    if (nextEffort === normalizeReasoningEffort(reasoningEffort)) {
      setActionsOpen(false);
      return true;
    }
    if (typeof onReasoningEffortChange !== "function") {
      setError("当前版本没有连接到 Suzu 思考强度设置。");
      return false;
    }
    setSavingReasoningEffort(true);
    setError("");
    try {
      await onReasoningEffortChange(nextEffort);
      setActionsOpen(false);
      return true;
    } catch (cause) {
      setError(`无法切换思考强度：${clean(cause?.message || cause) || "未知错误。"}`);
      return false;
    } finally {
      setSavingReasoningEffort(false);
    }
  }, [onReasoningEffortChange, phase, reasoningEffort, savingReasoningEffort]);

  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, refresh]);

  useEffect(() => {
    if (open) return;
    setActionsOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || !actionsOpen) return undefined;
    const closeActions = (event) => {
      const target = event.target;
      if (actionsRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="listbox"]')) return;
      setActionsOpen(false);
    };
    window.addEventListener("pointerdown", closeActions);
    return () => window.removeEventListener("pointerdown", closeActions);
  }, [actionsOpen, open]);

  // Agent Core durably appends each model/tool step while a turn is still
  // running. Poll that same transcript cadence as the main conversation so a
  // multi-step software task arrives in sequence instead of all at completion.
  useEffect(() => {
    if (!open || !["thinking", "replying"].includes(phase)) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [open, phase, refresh]);

  useEffect(() => {
    if (typeof api?.onEvent !== "function") return undefined;
    return api.onEvent((event) => {
      const requestId = clean(event?.requestId);
      if (activeRequestRef.current && requestId && requestId !== activeRequestRef.current) return;
      if (event?.type === "turn-started" || event?.type === "thinking") {
        setPhase("thinking");
        projectLiveReply(event);
        return;
      }
      if (event?.type === "reply-stream") {
        setPhase("replying");
        projectLiveReply(event);
        return;
      }
      if (event?.type === "reply") {
        setPhase("replying");
        projectLiveReply(event, { final: true });
        return;
      }
      if (event?.type === "turn-complete" || event?.type === "turn-stopped") {
        const completedRequestId = requestId;
        activeRequestRef.current = "";
        if (event?.type === "turn-stopped") {
          setLiveReplies((current) => {
            const requestId = clean(event?.requestId);
            const reply = current.get(requestId);
            if (!reply) return current;
            const next = new Map(current);
            next.set(requestId, { ...reply, done: true, phase: "idle" });
            return next;
          });
        }
        setPhase("idle");
        void refresh().then((snapshot) => {
          if (event?.type !== "turn-complete" || snapshot?.status !== "ready" || !completedRequestId) return;
          setLiveReplies((current) => {
            if (!current.has(completedRequestId)) return current;
            const next = new Map(current);
            next.delete(completedRequestId);
            return next;
          });
        });
        return;
      }
      if (event?.type === "error") {
        activeRequestRef.current = "";
        setPhase("idle");
        setLiveReplies((current) => {
          const requestId = clean(event?.requestId);
          const reply = current.get(requestId);
          if (!reply) return current;
          const next = new Map(current);
          next.set(requestId, { ...reply, done: true, phase: "idle" });
          return next;
        });
        setError(clean(event.message) || "软件助手没有完成这次回复。");
      }
    });
  }, [api, projectLiveReply, refresh]);

  useEffect(() => {
    const prompt = clean(initialPrompt);
    if (!open || !sessionId || !prompt || processedPromptRef.current === prompt) return;
    processedPromptRef.current = prompt;
    onPromptConsumed?.();
    void send(prompt);
  }, [initialPrompt, onPromptConsumed, open, send, sessionId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (actionsOpen) {
        setActionsOpen(false);
        return;
      }
      onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actionsOpen, onClose, open]);

  useEffect(() => {
    const history = historyRef.current;
    if (!open || !history) return;
    history.scrollTop = history.scrollHeight;
  }, [liveReplies, messages, open, pendingMessages, phase]);

  const busy = phase !== "idle";
  const history = mergeConversationMessages(messages, pendingMessages, liveReplies, sessionId);
  const visibleHistory = history.length ? history : [{
    blocks: [{ kind: "text", text: INTRODUCTION }],
    id: "software-assistant:intro",
    kind: "assistant",
  }];
  const messageRows = visibleHistory.map((message) => conversationRow(message, owner)).filter(Boolean);
  const assistantName = phase === "clearing" ? "正在清空记录..." : busy ? "正在输入中..." : "Suzu";
  const canStop = ["thinking", "replying"].includes(phase);
  const selectedReasoningEffort = normalizeReasoningEffort(reasoningEffort);

  const dialog = (
    <div aria-hidden={open ? undefined : true} className={`software-assistant-overlay${open ? " is-open" : ""}${resizing ? " is-resizing" : ""}`}>
      <section
        aria-label="问 Suzu"
        aria-modal="false"
        className="software-assistant-dialog"
        id="suzu-software-assistant-dialog"
        role="dialog"
        style={{ "--software-assistant-panel-width": `${visiblePanelWidth}px` }}
      >
        <div
          aria-label="调整 Suzu 面板宽度"
          aria-orientation="vertical"
          aria-valuemax={SOFTWARE_ASSISTANT_PANEL_MAX_WIDTH}
          aria-valuemin={SOFTWARE_ASSISTANT_PANEL_MIN_WIDTH}
          aria-valuenow={visiblePanelWidth}
          className="software-assistant-dialog__resizer"
          onKeyDown={resizePanelFromKeyboard}
          onLostPointerCapture={cancelPanelResize}
          onPointerCancel={cancelPanelResize}
          onPointerDown={beginPanelResize}
          onPointerMove={resizePanel}
          onPointerUp={finishPanelResize}
          role="separator"
          tabIndex={0}
          title="拖动调整 Suzu 面板宽度"
        />
        <header className="software-assistant-dialog__header">
          <div>
            <span>SUZU LIVES</span>
            <h2 aria-live="polite">{assistantName}</h2>
          </div>
          <div className="software-assistant-dialog__header-actions" ref={actionsRef}>
            <button
              aria-expanded={actionsOpen}
              aria-haspopup="dialog"
              aria-label="更多 Suzu 助手操作"
              className="software-assistant-dialog__more"
              onClick={() => setActionsOpen((current) => !current)}
              type="button"
            >⋯</button>
            {actionsOpen ? (
              <div aria-label="Suzu 助手操作" className="software-assistant-dialog__menu" role="dialog">
                <label className="software-assistant-dialog__menu-setting">
                  <span>思考强度</span>
                  <Select
                    ariaLabel="Suzu 助手思考强度"
                    className="software-assistant-dialog__menu-select"
                    disabled={busy || savingReasoningEffort}
                    fullWidth
                    onChange={(value) => { void changeReasoningEffort(value); }}
                    options={SOFTWARE_ASSISTANT_REASONING_EFFORT_OPTIONS}
                    value={selectedReasoningEffort}
                  />
                </label>
                <span aria-hidden="true" className="software-assistant-dialog__menu-separator" />
                <button aria-label="清空问 Suzu 的记录" className="software-assistant-dialog__menu-danger" disabled={busy || !sessionId} onClick={() => { setActionsOpen(false); void clearHistory(); }} type="button">清空记录</button>
              </div>
            ) : null}
            <button aria-label="关闭问 Suzu" className="software-assistant-dialog__close" onClick={onClose} type="button">×</button>
          </div>
        </header>
        <div aria-live="polite" className="software-assistant-dialog__history content--conversation" ref={historyRef} role="log">
          <ConversationMessageList rows={messageRows} />
        </div>
        <footer className="software-assistant-dialog__footer">
          {error ? <p className="software-assistant-dialog__error" role="alert">{error}</p> : null}
          <form onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}>
            <Input
              aria-label="向 Suzu 提问"
              autoComplete="off"
              disabled={!sessionId}
              maxLength={12000}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="告诉 Suzu 你想完成什么"
              ref={composerRef}
              size="lg"
              value={draft}
            />
            <div className="software-assistant-dialog__composer-actions">
              {canStop ? <button className="software-assistant-dialog__stop" onClick={() => { void stop(); }} type="button">停止</button> : null}
              <button className="software-assistant-dialog__send" disabled={!clean(draft) || !sessionId} type="submit">发送</button>
            </div>
          </form>
        </footer>
      </section>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
