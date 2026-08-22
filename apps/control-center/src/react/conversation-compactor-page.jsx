import { useEffect, useState } from "react";
import {
  DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS,
  DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD,
} from "@suzu-lives/suzu-agent-runtime/compaction-defaults";
import { Avatar, Banner, Button, Empty, GlassPanel, Input, PageHeader, Roster, Status, Switch, Textarea } from "suzu-design-system";

import { PageScaffold } from "./page-scaffold.jsx";
import "./conversation-compactor-page.css";

function clean(value) {
  return String(value ?? "").trim();
}

function tokenValue(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : String(fallback);
}

function initialDraft(snapshot) {
  const settings = snapshot?.settings || {};
  return {
    automaticEnabled: settings.automatic?.enabled === true,
    automaticRetainTokens: tokenValue(settings.automatic?.retainTokens, DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS),
    automaticThreshold: tokenValue(settings.automatic?.tokenThreshold, DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD),
    manualRetainTokens: tokenValue(settings.manual?.retainTokens, DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS),
    prompt: String(settings.prompt ?? ""),
  };
}

function runStatus(lastRun) {
  const status = clean(lastRun?.status);
  if (status === "completed") return { label: "最近一次已完成", tone: "success" };
  if (status === "failed") return { label: "最近一次失败", tone: "danger" };
  if (status === "running") return { label: "正在整理", tone: "warning" };
  return { label: "还没有压缩记录", tone: "muted" };
}

function ContactRail({ contacts, disabled, selectedContactId, onSelect }) {
  return (
    <GlassPanel as="aside" className="conversation-compactor-session-rail" intensity="soft">
      <div className="conversation-compactor-session-rail__heading">
        <div><span>CONTACTS</span><strong>联系人</strong></div>
        <b>{contacts.length}</b>
      </div>
      <div className="conversation-compactor-contact-list" aria-label="选择联系人">
        {contacts.map((contact) => {
          const name = clean(contact.name) || "未命名联系人";
          const selected = clean(contact.id) === clean(selectedContactId);
          return (
            <Roster
              avatar={<Avatar name={name} size="md" />}
              className="conversation-compactor-contact"
              key={contact.id}
              name={name}
              onClick={disabled ? undefined : () => onSelect(contact.id)}
              selected={selected}
              subtitle={selected ? "当前联系人" : "切换到此联系人"}
            />
          );
        })}
      </div>
    </GlassPanel>
  );
}

/**
 * This page edits product-owned settings only.  The actual history replacement
 * happens inside Agent Core; the rendered chat remains a full append-only
 * transcript even after compaction.
 */
export function ConversationCompactorPage({ actions = {}, error = "", loading = false, snapshot = null }) {
  const [draft, setDraft] = useState(() => initialDraft(snapshot));
  const [pending, setPending] = useState("");
  const selectedContactId = clean(snapshot?.selectedContactId);
  const settingsRevision = `${selectedContactId}\u0000${clean(snapshot?.settings?.updatedAt)}\u0000${String(snapshot?.settings?.prompt ?? "")}`;

  useEffect(() => {
    setDraft(initialDraft(snapshot));
  }, [settingsRevision]);

  const busy = loading || Boolean(pending);
  const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
  const selectedConversation = snapshot?.selectedConversation || null;
  const status = runStatus(snapshot?.lastRun);

  const selectContact = async (contactId) => {
    if (busy || clean(contactId) === selectedContactId) return;
    setPending("contact");
    try {
      await actions.selectContact?.(contactId);
    } finally {
      setPending("");
    }
  };

  const save = async (kind) => {
    if (!selectedContactId || busy) return;
    setPending(kind);
    try {
      if (kind === "automatic") {
        await actions.save?.({
          contactId: selectedContactId,
          automatic: {
            enabled: draft.automaticEnabled,
            tokenThreshold: draft.automaticThreshold,
            retainTokens: draft.automaticRetainTokens,
          },
        });
      } else {
        await actions.save?.({ contactId: selectedContactId, prompt: draft.prompt });
      }
    } finally {
      setPending("");
    }
  };

  const run = async () => {
    if (!selectedContactId || busy) return;
    setPending("manual");
    try {
      await actions.run?.({
        contactId: selectedContactId,
        manual: { retainTokens: draft.manualRetainTokens },
      });
    } finally {
      setPending("");
    }
  };

  return (
    <PageScaffold
      canvasClassName="page-canvas--fill"
      className="conversation-compactor-react-page"
      header={(
        <PageHeader
          action={<Button className="conversation-compactor-return-button" onClick={actions.returnToOverview} variant="secondary">返回关系</Button>}
          eyebrow="CONVERSATION MEMORY"
          subtitle="压缩只替换模型上下文；聊天界面始终保留完整的原始对话。"
          title="记忆压缩器"
        />
      )}
    >
      <div className="conversation-compactor-page-body">

        {error ? <Banner className="conversation-compactor-page-error" tone="danger">{error}</Banner> : null}
        {!snapshot && loading ? (
          <GlassPanel as="section" className="conversation-compactor-loading" intensity="soft">
            <Status label="正在读取对话设置" tone="warning" />
          </GlassPanel>
        ) : !selectedConversation ? (
          <GlassPanel as="section" className="conversation-compactor-contact-empty" intensity="soft">
            <Empty description="先创建并选择一位联系人，才能为她的固定对话设置压缩方式。" title="还没有可设置的联系人" />
          </GlassPanel>
        ) : (
          <div className="conversation-compactor-workspace">
            <ContactRail contacts={contacts} disabled={busy} onSelect={selectContact} selectedContactId={selectedContactId} />

          <GlassPanel as="section" className="conversation-compactor-workspace__main" intensity="soft">
            <header className="conversation-compactor-main-header">
              <div>
                <span>SUZU AGENT CORE COMPACTION</span>
                <h2>{selectedConversation.contactName}</h2>
                <p>模型接下来会看到“较早对话摘要 + 最近保留的原话”；已显示过的消息不会被摘要气泡替换。</p>
              </div>
              <Status label={busy ? "正在处理" : status.label} tone={busy ? "warning" : status.tone} />
            </header>

            <div className="conversation-compactor-main-body">
              {snapshot.historyError ? <Banner className="conversation-compactor-error" tone="warning">{snapshot.historyError}</Banner> : null}

              <div className="conversation-compactor-mode-grid">
                <section className="conversation-compactor-section">
                  <header>
                    <div><span>AUTOMATIC</span><h3>自动整理</h3></div>
                  </header>
                  <p className="conversation-compactor-section__description">Suzu Agent Core 每次真正发起模型请求前检查上下文；常规自动整理开启时按你的阈值整理，关闭时仍会在模型窗口接近 90% 时保底整理。</p>
                  <label className="conversation-compactor-switch-row">
                    <span><strong>按 Token 自动压缩</strong><small>关闭后不再按上方 Token 阈值整理；接近模型上下文上限时仍会自动保底整理。</small></span>
                    <Switch checked={draft.automaticEnabled} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, automaticEnabled: event.target.checked }))} />
                  </label>
                  <div className="conversation-compactor-number-grid">
                    <label className="conversation-compactor-field">
                      <span>触发阈值（Token）</span>
                      <Input disabled={busy} inputMode="numeric" min="1" onChange={(event) => setDraft((current) => ({ ...current, automaticThreshold: event.target.value }))} type="number" value={draft.automaticThreshold} />
                    </label>
                    <label className="conversation-compactor-field">
                      <span>保留最近原话（Token）</span>
                      <Input disabled={busy} inputMode="numeric" min="1" onChange={(event) => setDraft((current) => ({ ...current, automaticRetainTokens: event.target.value }))} type="number" value={draft.automaticRetainTokens} />
                    </label>
                  </div>
                  <p className="conversation-compactor-section__hint">目标是约 32,000 Token 触发，并保留最近约 8,000 Token 原话；小上下文模型会自动收紧。保留值必须小于实际触发阈值。</p>
                  <div className="conversation-compactor-section-actions">
                    <Button disabled={busy} onClick={() => void save("automatic")}>{pending === "automatic" ? "正在保存…" : "保存自动设置"}</Button>
                  </div>
                </section>

                <section className="conversation-compactor-section">
                  <header>
                    <div><span>MANUAL REWIND</span><h3>立即整理</h3></div>
                  </header>
                  <p className="conversation-compactor-section__description">现在就整理较早聊天，但仍保留你指定数量的最近原话，不会把整段对话全变成摘要。</p>
                  <label className="conversation-compactor-field">
                    <span>本次保留最近原话（Token）</span>
                    <Input disabled={busy || !selectedConversation.hasTranscript} inputMode="numeric" min="1" onChange={(event) => setDraft((current) => ({ ...current, manualRetainTokens: event.target.value }))} type="number" value={draft.manualRetainTokens} />
                  </label>
                  <p className="conversation-compactor-section__hint">Suzu Agent Core 会原子地写入压缩事件；原始聊天记录不会被删除，界面仍按完整消息显示。</p>
                  <div className="conversation-compactor-section-actions">
                    <Button className="conversation-compactor-run-button" disabled={busy || !selectedConversation.hasTranscript} onClick={() => void run()}>
                      {pending === "manual" ? "正在整理…" : "立即压缩"}
                    </Button>
                  </div>
                </section>
              </div>

              <section className="conversation-compactor-section">
                <header>
                  <div><span>SUMMARY PROMPT</span><h3>摘要提示词</h3></div>
                </header>
                <p className="conversation-compactor-section__description">这是这位联系人的默认摘要指令。可直接改成你自己的写法；清空后保存会恢复内置默认提示词。</p>
                <label className="conversation-compactor-prompt-field">
                  <span>提示词</span>
                  <Textarea disabled={busy} maxLength="24000" onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} rows={9} value={draft.prompt} />
                </label>
                <div className="conversation-compactor-section-actions">
                  <Button disabled={busy} onClick={() => void save("prompt")}>{pending === "prompt" ? "正在保存…" : "保存提示词"}</Button>
                </div>
              </section>

              <section className="conversation-compactor-section">
                <header>
                  <div><span>LATEST CHECKPOINT</span><h3>最近一次结果</h3></div>
                  {snapshot.lastRun ? <small>{snapshot.lastRun.completedAt || snapshot.lastRun.startedAt || "正在等待结果"}</small> : null}
                </header>
                {snapshot.lastRun?.error ? <Banner className="conversation-compactor-error" tone="danger">{snapshot.lastRun.error}</Banner> : null}
                {snapshot.latestSummary ? (
                  <pre className="conversation-compactor-summary">{snapshot.latestSummary}</pre>
                ) : (
                  <div className="conversation-compactor-summary conversation-compactor-summary--empty">还没有生成对话摘要。</div>
                )}
              </section>
            </div>
            </GlassPanel>
          </div>
        )}
      </div>
    </PageScaffold>
  );
}
