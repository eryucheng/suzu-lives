import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "suzu-design-system";
import { createPortal } from "react-dom";

import { conversationMessageBlocks, mergeConversationMessages, projectedLiveReply } from "../features/conversation/index.mjs";
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

  const refresh = useCallback(async () => {
    if (typeof api?.snapshot !== "function") {
      setError("当前版本没有连接到 Suzu 使用助手。");
      return null;
    }
    try {
      const snapshot = await api.snapshot();
      if (snapshot?.status === "ready") {
        setMessages(displayMessages(snapshot.messages));
        setSessionId(clean(snapshot.sessionId));
        setError("");
        setPhase(snapshot.running === true ? "thinking" : "idle");
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
    if (!text || phase !== "idle") return false;
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
          ? { ...item, accepted: true, requestId: activeRequestRef.current, sessionId: acceptedSessionId }
          : item
      )));
      return true;
    } catch (cause) {
      setPendingMessages((current) => current.filter((item) => item.id !== pending.id));
      setPhase("idle");
      setError(`无法发送：${clean(cause?.message || cause) || "未知错误。"}`);
      return false;
    }
  }, [api, phase, sessionId]);

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
    if (phase === "idle" || typeof api?.stop !== "function") return;
    try {
      await api.stop({ requestId: activeRequestRef.current });
    } catch (cause) {
      setError(`无法停止：${clean(cause?.message || cause) || "未知错误。"}`);
    }
  }, [api, phase]);

  useEffect(() => {
    if (!open) {
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
  }, [open, refresh]);

  // Agent Core durably appends each model/tool step while a turn is still
  // running. Poll that same transcript cadence as the main conversation so a
  // multi-step software task arrives in sequence instead of all at completion.
  useEffect(() => {
    if (!open || phase === "idle") return undefined;
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
        void refresh();
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
  const assistantName = busy ? "正在输入中..." : "Suzu";

  const dialog = (
    <div className="software-assistant-overlay" onMouseDown={onClose}>
      <section aria-label="问 Suzu" aria-modal="true" className="software-assistant-dialog" id="suzu-software-assistant-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <header className="software-assistant-dialog__header">
          <div>
            <span>SUZU LIVES</span>
            <h2 aria-live="polite">{assistantName}</h2>
          </div>
          <button aria-label="关闭问 Suzu" className="software-assistant-dialog__close" onClick={onClose} type="button">×</button>
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
              disabled={busy || !sessionId}
              maxLength={12000}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="例如：帮我切换为夜间模式，或我想配置语音通话"
              ref={composerRef}
              size="lg"
              value={draft}
            />
            {busy ? <button className="software-assistant-dialog__stop" onClick={() => { void stop(); }} type="button">停止</button> : <button className="software-assistant-dialog__send" disabled={!clean(draft) || !sessionId} type="submit">发送</button>}
          </form>
        </footer>
      </section>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
