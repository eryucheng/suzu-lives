import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "suzu-design-system";
import { createPortal } from "react-dom";

import {
  conversationMessageBlocks,
  mergeConversationMessageWindow,
  mergeConversationMessages,
  projectedLiveReply,
} from "../features/conversation/index.mjs";
import { ConversationMessageList } from "./conversation-page.jsx";
import "./software-assistant-dialog.css";

function clean(value) {
  return String(value ?? "").trim();
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
 * A small persistent chat surface for the fixed product-help Agent Core session.
 * It intentionally owns none of the contact conversation UI or its memory.
 */
export function SoftwareAssistantDialog({ api, initialPrompt = "", onClose, onPromptConsumed, open = false, owner = null }) {
  const [messages, setMessages] = useState([]);
  const [pendingMessages, setPendingMessages] = useState([]);
  const [liveReplies, setLiveReplies] = useState(() => new Map());
  const [sessionId, setSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const composerRef = useRef(null);
  const historyRef = useRef(null);
  const processedPromptRef = useRef("");
  const activeRequestRef = useRef("");
  // A history snapshot is asynchronous while turn events can continue to
  // arrive.  Keep the visible transcript monotonic: a late, shorter snapshot
  // must never replace rows the person has already seen.
  const historyEpochRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const appliedRefreshSequenceRef = useRef(0);

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

  useEffect(() => {
    if (!open) {
      invalidateHistoryRefreshes();
      setDraft("");
      setPendingMessages([]);
      setLiveReplies(new Map());
      setSessionId("");
      setPhase("idle");
      setError("");
      activeRequestRef.current = "";
      processedPromptRef.current = "";
      return undefined;
    }
    void refresh();
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [invalidateHistoryRefreshes, open, refresh]);

  // Agent Core durably appends each model/tool step while a turn is still
  // running. Poll that same transcript cadence as the main conversation so a
  // multi-step software task arrives in sequence instead of all at completion.
  useEffect(() => {
    if (!open || !["thinking", "replying"].includes(phase)) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [open, phase, refresh]);

  useEffect(() => {
    if (!open || typeof api?.onEvent !== "function") return undefined;
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
  }, [api, open, projectLiveReply, refresh]);

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
      onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    const history = historyRef.current;
    if (!open || !history) return;
    history.scrollTop = history.scrollHeight;
  }, [liveReplies, messages, open, pendingMessages, phase]);

  if (!open) return null;
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

  const dialog = (
    <div className="software-assistant-overlay" onMouseDown={onClose}>
      <section aria-label="问 Suzu" aria-modal="true" className="software-assistant-dialog" id="suzu-software-assistant-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <header className="software-assistant-dialog__header">
          <div>
            <span>SUZU LIVES</span>
            <h2 aria-live="polite">{assistantName}</h2>
          </div>
          <div className="software-assistant-dialog__header-actions">
            <button aria-label="清空问 Suzu 的记录" className="software-assistant-dialog__clear" disabled={busy || !sessionId} onClick={() => { void clearHistory(); }} type="button">清空记录</button>
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
