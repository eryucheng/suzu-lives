import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "suzu-design-system";

import "./software-assistant-dialog.css";

function clean(value) {
  return String(value ?? "").trim();
}

function textBlocks(message) {
  return (Array.isArray(message?.blocks) ? message.blocks : [])
    .filter((block) => clean(block?.kind || "text") === "text" && clean(block?.text))
    .map((block) => clean(block.text));
}

function displayMessages(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const kind = clean(message?.kind);
    const blocks = textBlocks(message);
    if (!blocks.length || !["user", "assistant"].includes(kind)) return [];
    return [{
      id: clean(message?.id) || `${kind}:${blocks.join("\n").slice(0, 80)}`,
      kind,
      text: blocks.join("\n"),
    }];
  });
}

const INTRODUCTION = "我可以帮你找到软件功能、直接切换已支持的设置，或一步步说明 API 和能力该怎么配置。";

function Bubble({ message }) {
  return (
    <article className={`software-assistant-message software-assistant-message--${message.kind}`}>
      <span className="software-assistant-message__name">{message.kind === "user" ? "你" : "Suzu 使用助手"}</span>
      <p>{message.text}</p>
    </article>
  );
}

/**
 * A small persistent chat surface for the fixed product-help Agent Core session.
 * It intentionally owns none of the contact conversation UI or its memory.
 */
export function SoftwareAssistantDialog({ api, initialPrompt = "", onClose, onPromptConsumed, open = false }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [streamedReply, setStreamedReply] = useState("");
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
        setError("");
        if (snapshot.running !== true) setPhase("idle");
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
    if (typeof api?.send !== "function") {
      setError("当前版本没有连接到 Suzu 使用助手。");
      return false;
    }
    const localId = `local:${Date.now()}`;
    setMessages((current) => [...current, { id: localId, kind: "user", text }]);
    setDraft("");
    setStreamedReply("");
    setError("");
    setPhase("thinking");
    try {
      const result = await api.send({ content: text });
      activeRequestRef.current = clean(result?.requestId);
      if (result?.accepted !== true) throw new Error("软件助手没有接受这条问题。");
      return true;
    } catch (cause) {
      setMessages((current) => current.filter((message) => message.id !== localId));
      setPhase("idle");
      setError(`无法发送：${clean(cause?.message || cause) || "未知错误。"}`);
      return false;
    }
  }, [api, phase]);

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
      setStreamedReply("");
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

  useEffect(() => {
    if (!open || typeof api?.onEvent !== "function") return undefined;
    return api.onEvent((event) => {
      const requestId = clean(event?.requestId);
      if (activeRequestRef.current && requestId && requestId !== activeRequestRef.current) return;
      if (event?.type === "turn-started" || event?.type === "thinking") {
        setPhase("thinking");
        return;
      }
      if (event?.type === "reply-stream") {
        setPhase("replying");
        setStreamedReply(clean(event.content));
        return;
      }
      if (event?.type === "reply") {
        setPhase("replying");
        setStreamedReply(clean(event.content));
        return;
      }
      if (event?.type === "turn-complete" || event?.type === "turn-stopped") {
        activeRequestRef.current = "";
        setStreamedReply("");
        setPhase("idle");
        void refresh();
        return;
      }
      if (event?.type === "error") {
        activeRequestRef.current = "";
        setPhase("idle");
        setStreamedReply("");
        setError(clean(event.message) || "软件助手没有完成这次回复。");
      }
    });
  }, [api, open, refresh]);

  useEffect(() => {
    const prompt = clean(initialPrompt);
    if (!open || !prompt || processedPromptRef.current === prompt) return;
    processedPromptRef.current = prompt;
    onPromptConsumed?.();
    void send(prompt);
  }, [initialPrompt, onPromptConsumed, open, send]);

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
  }, [messages, open, phase, streamedReply]);

  if (!open) return null;
  const busy = phase !== "idle";
  const history = messages.length ? messages : [{ id: "software-assistant:intro", kind: "assistant", text: INTRODUCTION }];

  return (
    <div className="software-assistant-overlay" onMouseDown={onClose}>
      <section aria-label="问 Suzu" aria-modal="true" className="software-assistant-dialog" id="suzu-software-assistant-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <header className="software-assistant-dialog__header">
          <div>
            <span>SUZU LIVES</span>
            <h2>问 Suzu</h2>
            <p>软件使用助手 · 默认不读取联系人或长期记忆</p>
          </div>
          <button aria-label="关闭问 Suzu" className="software-assistant-dialog__close" onClick={onClose} type="button">×</button>
        </header>
        <div aria-live="polite" className="software-assistant-dialog__history" ref={historyRef}>
          {history.map((message) => <Bubble key={message.id} message={message} />)}
          {busy ? <article className="software-assistant-message software-assistant-message--assistant software-assistant-message--pending"><span className="software-assistant-message__name">Suzu 使用助手</span><p>{streamedReply || (phase === "thinking" ? "正在查看软件状态…" : "正在整理回复…")}</p></article> : null}
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
              disabled={busy}
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
            {busy ? <button className="software-assistant-dialog__stop" onClick={() => { void stop(); }} type="button">停止</button> : <button className="software-assistant-dialog__send" disabled={!clean(draft)} type="submit">发送</button>}
          </form>
        </footer>
      </section>
    </div>
  );
}
