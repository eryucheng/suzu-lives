import { Avatar, Banner, Button, Empty, GlassPanel, PageHeader, Roster, Status } from "suzu-design-system";

import { PageScaffold } from "./page-scaffold.jsx";
import "./agent-journal-page.css";

function clean(value) {
  return String(value ?? "").trim();
}

function dateLabel(value) {
  const source = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(source)) return source || "日期未知";
  const date = new Date(`${source}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return source;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "写入时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function ContactRail({ contacts, loading, onSelect, selectedContactId }) {
  return (
    <GlassPanel as="aside" className="agent-journal-contact-rail" intensity="soft">
      <div className="agent-journal-contact-rail__heading">
        <div><span>CONTACTS</span><strong>联系人</strong></div>
        <b>{contacts.length}</b>
      </div>
      <div aria-label="选择查看日记的联系人" className="agent-journal-contact-list">
        {contacts.map((contact) => {
          const selected = contact.id === selectedContactId;
          const name = clean(contact.name) || "未命名联系人";
          return <Roster
            avatar={<Avatar name={name} size="md" />}
            className="agent-journal-contact"
            key={contact.id}
            name={name}
            onClick={loading ? undefined : () => onSelect?.({ contactId: contact.id })}
            selected={selected}
            subtitle={selected ? "当前联系人" : "切换到此联系人"}
          />;
        })}
      </div>
    </GlassPanel>
  );
}

function JournalEntry({ entry }) {
  return (
    <article className="agent-journal-entry">
      <header>
        <div><span>DAILY ENTRY</span><h3>{dateLabel(entry?.date)}</h3></div>
        <time dateTime={clean(entry?.updatedAt) || undefined}>{timeLabel(entry?.updatedAt || entry?.createdAt)}</time>
      </header>
      <p>{clean(entry?.content)}</p>
    </article>
  );
}

export function AgentJournalPage({ actions = {}, error = "", loading = false, snapshot = null }) {
  const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const selected = snapshot?.selectedContact || null;
  const ready = Boolean(snapshot);

  return (
    <PageScaffold
      canvasClassName="page-canvas--fill"
      className="agent-journal-react-page"
      header={(
        <PageHeader
          action={<div className="agent-journal-header-actions"><Button disabled={loading} onClick={() => actions.refresh?.({ contactId: snapshot?.selectedContactId || "" })} type="button" variant="secondary">刷新</Button><Button disabled={loading} onClick={actions.returnToOverview} type="button" variant="secondary">返回关系</Button></div>}
          eyebrow="AGENT JOURNAL"
          subtitle="由 Agent 在设定时间写下当天值得记录的事；它与长期记忆、会话压缩器完全分开。你要求时，Agent 可以只读查看自己的日记。"
          title="查看日记"
        />
      )}
    >
      <div className="agent-journal-page-body">
        {error ? <Banner className="agent-journal-page-error" tone="danger">{error}</Banner> : null}
        {!ready ? (
          <GlassPanel as="section" className="agent-journal-loading" intensity="soft"><Empty description={loading ? "正在读取本地日记。" : "暂时无法读取 Agent 日记。"} title={loading ? "正在加载日记" : "无法加载日记"} /></GlassPanel>
        ) : !contacts.length ? (
          <GlassPanel as="section" className="agent-journal-loading" intensity="soft"><Empty description="先创建联系人，再到能力 → 行动中为其开启“写日记”。" title="还没有联系人" /></GlassPanel>
        ) : (
          <section aria-label="Agent 日记" className="agent-journal-workspace">
            <ContactRail contacts={contacts} loading={loading} onSelect={actions.selectContact} selectedContactId={snapshot?.selectedContactId} />
            <GlassPanel as="section" className="agent-journal-main" intensity="soft">
              <header className="agent-journal-main__header">
                <div><span>JOURNAL OF</span><h2>{selected?.name || "未命名联系人"}</h2><p>这里只显示这位 Agent 已经写下的日记，不会改动聊天记录或长期记忆。</p></div>
                <Status label={entries.length ? `${entries.length} 篇` : "尚未写下"} tone={entries.length ? "success" : "muted"} />
              </header>
              {entries.length ? <div className="agent-journal-entry-list">{entries.map((entry) => <JournalEntry entry={entry} key={entry.date} />)}</div> : <Empty description="在能力 → 行动中开启“写日记”后，Agent 会在设定时间完成当天第一篇回顾。软件未运行的日期不会补写。" title="这位联系人还没有日记" />}
            </GlassPanel>
          </section>
        )}
      </div>
    </PageScaffold>
  );
}
