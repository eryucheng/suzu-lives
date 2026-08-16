import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Empty,
  GlassPanel,
  Input,
  PageHeader,
  Select,
  Status,
  Switch,
  Textarea,
} from "suzu-design-system";

import "./conversation-compactor-page.css";

function clean(value) {
  return String(value ?? "").trim();
}

function dateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function positiveTokenText(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : String(fallback);
}

function settingsDraft(settings = {}) {
  const automatic = settings?.automatic || {};
  const manual = settings?.manual || {};
  return {
    automatic: {
      enabled: automatic.enabled === true,
      retainTokens: positiveTokenText(automatic.retainTokens, 10_000),
      time: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(String(automatic.time || "")) ? automatic.time : "09:00",
      tokenThreshold: positiveTokenText(automatic.tokenThreshold, 60_000),
      trigger: automatic.trigger === "time" ? "time" : "token",
    },
    manual: {
      retainTokens: positiveTokenText(manual.retainTokens, 10_000),
    },
    prompt: settings?.prompt || "",
  };
}

function runStatus(lastRun) {
  if (!lastRun) return { label: "尚未压缩", tone: "muted" };
  if (lastRun.status === "written") return { label: "已完成压缩", tone: "success" };
  if (lastRun.status === "imported") return { label: "已导入历史", tone: "success" };
  if (lastRun.status === "dry-run") return { label: "已检查", tone: "warning" };
  if (lastRun.status === "skipped") return { label: "未达到压缩条件", tone: "muted" };
  return { label: "已有记录", tone: "muted" };
}

function runDescription(lastRun) {
  if (!lastRun) return "还没有这位联系人的压缩或导入记录。";
  if (lastRun.status === "written") {
    const when = dateLabel(lastRun.writtenAt);
    return `${when ? `${when} 已` : "已"}压缩 ${lastRun.messagesCompacted || 0} 条较早消息。`;
  }
  if (lastRun.status === "imported") {
    const when = dateLabel(lastRun.writtenAt);
    const source = lastRun.sourceFileName ? `「${lastRun.sourceFileName}」` : "历史 JSONL";
    return `${when ? `${when} 已` : "已"}导入 ${source}，并完整替换当前会话。`;
  }
  if (lastRun.reason) return lastRun.reason;
  if (lastRun.status === "dry-run") return "已完成检查，尚未写入摘要。";
  return "保留了上一次压缩结果。";
}

function ContactRail({ contacts, onSelect, pending, selectedContactId }) {
  return (
    <GlassPanel as="aside" className="conversation-compactor-session-rail" intensity="soft">
      <div className="conversation-compactor-session-rail__heading">
        <div><span>CONTACTS</span><strong>联系人</strong></div>
        <b>{contacts.length}</b>
      </div>
      <div aria-label="选择需要压缩的联系人" className="conversation-compactor-contact-list">
        {contacts.map((contact) => {
          const selected = contact.id === selectedContactId;
          return (
            <section className={`conversation-compactor-contact${selected ? " selected" : ""}`} key={contact.id}>
              <button
                aria-pressed={selected}
                className="conversation-compactor-contact-button"
                disabled={pending}
                onClick={() => onSelect({ contactId: contact.id })}
                type="button"
              >
                <strong>{contact.name || "未命名联系人"}</strong>
                <span>{contact.hasConversation ? "固定 Claude 对话" : "还没有聊天记录"}</span>
              </button>
            </section>
          );
        })}
      </div>
    </GlassPanel>
  );
}

function CompactorWorkspace({ actions, snapshot }) {
  const conversation = snapshot.selectedConversation;
  const selectedContact = snapshot.selectedContact;
  const [draft, setDraft] = useState(() => settingsDraft(snapshot.settings));
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const status = runStatus(snapshot.lastRun);
  const canCompact = conversation?.hasTranscript === true;

  useEffect(() => {
    setDraft(settingsDraft(snapshot.settings));
    setError("");
  }, [conversation?.contactId, snapshot.settings?.updatedAt]);

  const invoke = async (kind, callback) => {
    if (pending || !conversation) return;
    setPending(kind);
    setError("");
    try {
      await callback();
    } catch (actionError) {
      setError(clean(actionError?.message) || "无法完成这项记忆压缩操作。 ");
    } finally {
      setPending("");
    }
  };

  const contactScope = { contactId: conversation.contactId };
  const automatic = draft.automatic;
  const changeAutomatic = (key, value) => setDraft((current) => ({
    ...current,
    automatic: { ...current.automatic, [key]: value },
  }));
  const saveAutomatic = () => invoke("automatic", () => actions.save?.({
    ...contactScope,
    automatic,
  }));
  const savePrompt = () => invoke("prompt", () => actions.save?.({
    ...contactScope,
    prompt: draft.prompt,
  }));
  const runManual = () => invoke("manual", () => actions.run?.({
    ...contactScope,
    retainTokens: draft.manual.retainTokens,
  }));
  const importHistory = () => invoke("import", async () => {
    if (typeof actions.selectImportJsonl !== "function" || typeof actions.importJsonl !== "function") {
      throw new Error("当前环境无法导入历史 JSONL。 ");
    }
    const selected = await actions.selectImportJsonl();
    if (selected?.canceled || !clean(selected?.sourcePath)) return;
    const confirmed = typeof window === "undefined" || window.confirm(
      "会完整替换当前联系人的 Claude 会话 JSONL，并先创建安全备份。\n\n来源文件不会被修改；导入后会重新绑定到当前联系人的固定会话。\n\n确定导入吗？",
    );
    if (!confirmed) return;
    await actions.importJsonl({ ...contactScope, sourcePath: selected.sourcePath });
  });

  return (
    <GlassPanel as="section" className="conversation-compactor-workspace__main" intensity="soft">
      <header className="conversation-compactor-main-header">
        <div>
          <span>CONVERSATION COMPACTOR</span>
          <h2>{selectedContact?.name || conversation.contactName || "未命名联系人"}</h2>
          <p>{canCompact ? `固定 Claude 对话：${conversation.title}。自动设置、提示词和压缩记录都只属于这位联系人。` : "这位联系人还没有 Claude 聊天记录。"}</p>
        </div>
        <Status label={status.label} tone={status.tone} />
      </header>

      {error ? <Banner className="conversation-compactor-error" tone="danger">{error}</Banner> : null}

      <div className="conversation-compactor-main-body">
        <div className="conversation-compactor-mode-grid">
          <section className="conversation-compactor-section conversation-compactor-section--automatic">
            <header>
              <div><span>AUTOMATIC</span><h3>自动压缩</h3></div>
            </header>
            <label className="conversation-compactor-switch-row">
              <span><strong>开启自动压缩</strong><small>关闭后会移除这位联系人的自动任务。</small></span>
              <Switch
                aria-label="开启自动压缩"
                checked={automatic.enabled}
                disabled={!canCompact || Boolean(pending)}
                onChange={(event) => changeAutomatic("enabled", event.target.checked)}
              />
            </label>
            {automatic.enabled ? (
              <div className="conversation-compactor-automatic-fields">
                <label className="conversation-compactor-field">
                  <span>触发方式</span>
                  <Select
                    disabled={Boolean(pending)}
                    fullWidth
                    onChange={(trigger) => changeAutomatic("trigger", trigger)}
                    options={[{ label: "每天固定时间", value: "time" }, { label: "达到 Token 阈值", value: "token" }]}
                    value={automatic.trigger}
                  />
                </label>
                {automatic.trigger === "time" ? (
                  <label className="conversation-compactor-field">
                    <span>每天压缩时间</span>
                    <Input disabled={Boolean(pending)} onChange={(event) => changeAutomatic("time", event.target.value)} type="time" value={automatic.time} />
                  </label>
                ) : (
                  <label className="conversation-compactor-field">
                    <span>Token 触发阈值</span>
                    <Input disabled={Boolean(pending)} inputMode="numeric" min="1" onChange={(event) => changeAutomatic("tokenThreshold", event.target.value)} type="number" value={automatic.tokenThreshold} />
                  </label>
                )}
                <label className="conversation-compactor-field">
                  <span>保留最近 Token</span>
                  <Input disabled={Boolean(pending)} inputMode="numeric" min="1" onChange={(event) => changeAutomatic("retainTokens", event.target.value)} type="number" value={automatic.retainTokens} />
                </label>
                <p>由软件内置定时器执行；软件未运行时不会补跑。</p>
              </div>
            ) : <p className="conversation-compactor-section__description">手动压缩仍可随时使用。</p>}
            <div className="conversation-compactor-section-actions">
              <Button disabled={!canCompact || Boolean(pending)} onClick={saveAutomatic} type="button" variant="secondary">{pending === "automatic" ? "正在保存…" : "保存自动设置"}</Button>
            </div>
          </section>

          <section className="conversation-compactor-section conversation-compactor-section--manual">
            <header>
              <div><span>MANUAL</span><h3>手动压缩</h3></div>
            </header>
            <p className="conversation-compactor-section__description">现在就整理这位联系人的对话，并保留最近的原始内容。</p>
            <label className="conversation-compactor-field">
              <span>保留最近 Token</span>
              <Input disabled={!canCompact || Boolean(pending)} inputMode="numeric" min="1" onChange={(event) => setDraft((current) => ({ ...current, manual: { retainTokens: event.target.value } }))} type="number" value={draft.manual.retainTokens} />
            </label>
            <p className="conversation-compactor-section__hint">执行后会写入这位联系人的 Claude 对话摘要检查点，并保留本次备份。</p>
            <div className="conversation-compactor-section-actions">
              <Button className="conversation-compactor-run-button" disabled={!canCompact || Boolean(pending)} onClick={runManual} type="button">{pending === "manual" ? "正在压缩…" : "立即压缩"}</Button>
            </div>
          </section>
        </div>

        <section className="conversation-compactor-section conversation-compactor-section--import">
          <header>
            <div><span>IMPORT</span><h3>导入历史 JSONL</h3></div>
          </header>
          <p className="conversation-compactor-section__description">选择一份 Claude 会话 JSONL，完整替换当前联系人的会话记录。</p>
          <p className="conversation-compactor-section__hint">源文件不会被修改；替换前会自动备份当前会话，并重新绑定到当前联系人的固定会话。</p>
          <div className="conversation-compactor-section-actions">
            <Button disabled={!canCompact || Boolean(pending)} onClick={importHistory} type="button" variant="secondary">{pending === "import" ? "正在导入…" : "导入历史 JSONL"}</Button>
          </div>
        </section>

        <section className="conversation-compactor-section conversation-compactor-section--result">
          <header>
            <div><span>LAST RESULT</span><h3>最近一次操作</h3></div>
            {snapshot.lastRun?.mode ? <small>{snapshot.lastRun.mode}</small> : null}
          </header>
          <p className="conversation-compactor-section__description">{runDescription(snapshot.lastRun)}</p>
          {snapshot.latestSummary ? (
            <pre aria-label="最近一次联系人摘要" className="conversation-compactor-summary">{snapshot.latestSummary}</pre>
          ) : <div className="conversation-compactor-summary conversation-compactor-summary--empty">还没有生成联系人摘要。</div>}
        </section>

        <section className="conversation-compactor-section conversation-compactor-section--prompt">
          <header>
            <div><span>SUMMARY PROMPT</span><h3>摘要提示词</h3></div>
            {snapshot.settings?.updatedAt ? <small>{dateLabel(snapshot.settings.updatedAt)}</small> : null}
          </header>
          <p className="conversation-compactor-section__description">可选。留空时使用内置提示词；每位联系人都可单独保存自己的提示词。</p>
          <label className="conversation-compactor-prompt-field">
            <span>这位联系人的摘要提示词</span>
            <Textarea
              aria-label="这位联系人的摘要提示词"
              disabled={Boolean(pending)}
              maxLength={24000}
              onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
              placeholder="留空时使用内置压缩提示词。"
              rows={6}
              value={draft.prompt}
            />
          </label>
          <div className="conversation-compactor-section-actions">
            <Button disabled={Boolean(pending)} onClick={savePrompt} type="button" variant="secondary">{pending === "prompt" ? "正在保存…" : "保存提示词"}</Button>
          </div>
        </section>
      </div>
    </GlassPanel>
  );
}

function ContactWithoutConversation({ contact }) {
  const name = contact?.name || "这位联系人";
  return (
    <GlassPanel as="section" className="conversation-compactor-workspace__main conversation-compactor-contact-empty" intensity="soft">
      <Empty description="先在对话页与这位联系人聊几句；压缩器不会自行生成聊天记录。" title={`${name} 还没有可压缩的聊天记录`} />
    </GlassPanel>
  );
}

export function ConversationCompactorPage({ actions = {}, error = "", loading = false, snapshot = null }) {
  const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
  const ready = Boolean(snapshot);
  return (
    <div className="conversation-compactor-react-page">
      <PageHeader
        action={<Button className="conversation-compactor-return-button" onClick={actions.returnToOverview} variant="secondary">返回关系</Button>}
        eyebrow="CONVERSATION MEMORY"
        subtitle="按联系人分别设置自动压缩、手动压缩和摘要提示词。"
        title="记忆压缩器"
      />

      {error ? <Banner className="conversation-compactor-page-error" tone="danger">{error}</Banner> : null}
      {!ready ? (
        <GlassPanel as="section" className="conversation-compactor-loading" intensity="soft"><Empty description={loading ? "正在读取联系人聊天记录。" : "暂时无法读取联系人聊天记录。"} title={loading ? "正在加载记忆压缩器" : "无法加载记忆压缩器"} /></GlassPanel>
      ) : !contacts.length ? (
        <GlassPanel as="section" className="conversation-compactor-loading" intensity="soft"><Empty description="先创建一位联系人，再在对话中发送消息。" title="还没有联系人" /></GlassPanel>
      ) : (
        <section aria-label="记忆压缩器工作台" className="conversation-compactor-workspace">
          <ContactRail contacts={contacts} onSelect={actions.selectContact} pending={loading} selectedContactId={snapshot.selectedContactId} />
          {snapshot.selectedConversation
            ? <CompactorWorkspace actions={actions} snapshot={snapshot} />
            : <ContactWithoutConversation contact={snapshot.selectedContact} />}
        </section>
      )}
    </div>
  );
}
