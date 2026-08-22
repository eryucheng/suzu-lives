import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Banner, Button, Calendar, Dialog, GlassPanel, Input, PageHeader, Select, Status, Switch } from "suzu-design-system";

import { dateTime, money } from "../core/formatters.mjs";
import { PageScaffold } from "./page-scaffold.jsx";
import "./today-page.css";

const EVENT_TYPES = ["纪念日", "生日", "日程", "其他"];
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function two(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function monthKey(date) {
  return dateKey(date).slice(0, 7);
}

function validDateKey(value) {
  const source = String(value || "");
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateKey(date) === source ? source : "";
}

function monthDate(value, fallback) {
  const source = String(value || "");
  const match = source.match(/^(\d{4})-(\d{2})$/u);
  if (!match) return new Date(fallback.getFullYear(), fallback.getMonth(), 1);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return Number.isFinite(date.getTime()) ? date : new Date(fallback.getFullYear(), fallback.getMonth(), 1);
}

function shiftMonth(date, offset) {
  return monthKey(new Date(date.getFullYear(), date.getMonth() + offset, 1));
}

function dateLabel(value) {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAYS[(date.getDay() + 6) % 7]}`;
}

function eventsForDate(events, value) {
  const recurring = value.slice(5);
  return (events || []).filter((event) => event?.date === value || event?.date === recurring);
}

function calendarEvents(events, year, month) {
  const result = {};
  const prefix = `${year}-${two(month + 1)}-`;
  for (const event of events || []) {
    if (!event?.enabled) continue;
    const key = String(event.date || "").length === 5 ? `${year}-${event.date}` : String(event.date || "");
    if (!key.startsWith(prefix)) continue;
    const entries = result[key] || [];
    if (entries.length < 3) entries.push(event.source === "holiday" ? "holiday" : "personal");
    result[key] = entries;
  }
  return result;
}

function dateKindLabel(event) {
  if (event?.source === "holiday") return "节日";
  return event?.type || "纪念日";
}

function repeatLabel(event) {
  return String(event?.date || "").length === 5 ? "每年这一天" : "仅此一天";
}

function costLabel(summary, ready) {
  if (!ready) return "—";
  const requests = Number(summary?.requestCount || 0);
  const known = Number(summary?.knownRequestCount || 0);
  if (requests && !known) return "暂未计价";
  const amount = Number(summary?.amountCny || 0);
  return amount === 0 ? "¥0.00" : money(amount);
}

function costDetail(summary, ready) {
  if (!ready) return "进入联系人后显示";
  const requests = Number(summary?.requestCount || 0);
  const unknown = Number(summary?.unknownRequestCount || 0);
  if (!requests) return "今天还没有已识别调用";
  return `${requests} 次已识别调用${unknown ? ` · ${unknown} 次暂未计价` : ""}`;
}

function activityCost(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? money(amount) : "—";
}

function editorDate(event, selectedDate) {
  if (!event?.date) return selectedDate;
  return String(event.date).length === 5 ? `${selectedDate.slice(0, 5)}${event.date}` : event.date;
}

function editorSeed(editor, selectedDate, defaultContactId = "") {
  const event = editor?.event || null;
  return {
    contactId: event?.contactId || defaultContactId,
    id: event?.id || "",
    name: event?.name || "",
    date: editorDate(event, selectedDate),
    type: EVENT_TYPES.includes(event?.type) ? event.type : "纪念日",
    repeat: String(event?.date || "").length === 5,
    enabled: event?.enabled !== false,
  };
}

function TodayEventEditor({ actions = {}, editor, selectedDate, canEdit, contacts = [], defaultContactId = "" }) {
  const event = editor?.event || null;
  const key = `${event?.contactId || defaultContactId}:${event?.id || "new"}:${selectedDate}`;
  const [draft, setDraft] = useState(() => editorSeed(editor, selectedDate, defaultContactId));

  useEffect(() => setDraft(editorSeed(editor, selectedDate, defaultContactId)), [key, defaultContactId]);
  if (!editor) return null;

  const save = (formEvent) => {
    formEvent.preventDefault();
    void actions.saveEvent?.(draft);
  };
  const footer = (
    <div className="today-editor-actions">
      {event?.id ? <Button variant="danger" size="sm" onClick={() => void actions.removeEvent?.({ contactId: event.contactId, id: event.id, name: event.name })}>删除</Button> : <span />}
      <div>
        <Button variant="secondary" size="sm" onClick={() => actions.closeEditor?.()}>取消</Button>
        <Button variant="primary" size="sm" form="today-event-form" type="submit" disabled={!canEdit || !draft.contactId || !draft.name.trim() || !draft.date}>保存</Button>
      </div>
    </div>
  );

  const dialog = (
    <Dialog
      open
      onClose={() => actions.closeEditor?.()}
      title={event ? "编辑日期" : "添加日期"}
      footer={footer}
    >
      <form id="today-event-form" className="today-editor-form" data-suzu-today-editor onSubmit={save}>
        <label className="today-editor-field today-editor-field--wide">
          <span>联系人</span>
          <Select
            disabled={Boolean(event)}
            fullWidth
            onChange={(contactId) => setDraft((current) => ({ ...current, contactId }))}
            options={contacts.map((contact) => ({ label: contact.name, value: contact.id }))}
            placeholder="选择联系人"
            value={draft.contactId}
          />
        </label>
        <label className="today-editor-field today-editor-field--wide">
          <span>名称</span>
          <Input
            autoFocus
            maxLength={80}
            onChange={(inputEvent) => setDraft((current) => ({ ...current, name: inputEvent.target.value }))}
            placeholder="例如：我们的纪念日"
            required
            value={draft.name}
          />
        </label>
        <label className="today-editor-field">
          <span>日期</span>
          <Input
            onChange={(inputEvent) => setDraft((current) => ({ ...current, date: inputEvent.target.value }))}
            required
            type="date"
            value={draft.date}
          />
        </label>
        <label className="today-editor-field">
          <span>分类</span>
          <Select
            fullWidth
            onChange={(type) => setDraft((current) => ({ ...current, type }))}
            options={EVENT_TYPES.map((type) => ({ label: type, value: type }))}
            value={draft.type}
          />
        </label>
        <label className="today-editor-switch">
          <span><strong>每年重复</strong><small>按月日自动显示</small></span>
          <Switch checked={draft.repeat} onChange={(inputEvent) => setDraft((current) => ({ ...current, repeat: inputEvent.target.checked }))} />
        </label>
        <label className="today-editor-switch">
          <span><strong>显示在日历</strong><small>关闭后仍会保留</small></span>
          <Switch checked={draft.enabled} onChange={(inputEvent) => setDraft((current) => ({ ...current, enabled: inputEvent.target.checked }))} />
        </label>
      </form>
    </Dialog>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

function TodayEvents({ actions = {}, events, canEdit }) {
  if (!events.length) {
    return <div className="today-event-empty">这一天还没有要记住的事。</div>;
  }
  return (
    <div className="today-event-list">
      {events.map((event) => (
        <article className={`today-event-row${event.enabled ? "" : " is-paused"}`} key={event.contactId ? `${event.contactId}:${event.id}` : event.id}>
          <span className={`today-event-dot ${event.source === "holiday" ? "is-holiday" : ""}`} aria-hidden="true" />
          <div className="today-event-copy">
            <strong>{event.name}</strong>
            <div className="today-event-meta">
              {event.contactName ? <span className="today-event-contact">{event.contactName}</span> : null}
              <span>{dateKindLabel(event)} · {repeatLabel(event)}{event.enabled ? "" : " · 已暂停"}</span>
            </div>
          </div>
          {event.editable
            ? <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => actions.editEvent?.({ contactId: event.contactId, id: event.id })}>修改</Button>
            : <Status label="节日" tone="info" />}
        </article>
      ))}
    </div>
  );
}

export function TodayPage({ actions = {}, snapshot = {} }) {
  const now = new Date();
  const today = dateKey(now);
  const selectedDate = validDateKey(snapshot.selectedDate) || today;
  const month = monthDate(snapshot.month, new Date(`${selectedDate}T12:00:00`));
  const events = Array.isArray(snapshot.calendar?.events) ? snapshot.calendar.events : [];
  const contacts = Array.isArray(snapshot.calendar?.contacts) ? snapshot.calendar.contacts : [];
  const defaultContactId = String(snapshot.calendar?.defaultContactId || contacts[0]?.id || "");
  const selectedEvents = eventsForDate(events, selectedDate);
  const ready = snapshot.data?.status === "ready";
  const canEdit = snapshot.calendar?.canEdit === true;
  const calendarMarks = useMemo(
    () => calendarEvents(events, month.getFullYear(), month.getMonth()),
    [events, month],
  );
  // 首页只保留两条预览；完整调用记录由整张卡片进入用量页查看。
  const recentEvents = Array.isArray(snapshot.data?.events) ? snapshot.data.events.slice(-2).reverse() : [];
  return (
    <>
      <PageScaffold
        canvasClassName="page-canvas--fill"
        className="today-react-page page-layout__frame--bounded"
        header={<PageHeader eyebrow="TODAY" subtitle="把握当下" title="今天" />}
      >
      <div className="today-page-content">
        <section className="today-glass-workspace" aria-label="今日日历">
          <GlassPanel as="section" className="today-calendar-panel" intensity="soft">
            <Calendar
              className="today-calendar"
              events={calendarMarks}
              layout="fill"
              month={month.getMonth()}
              onGoToday={() => actions.goToday?.()}
              onNextMonth={() => actions.setMonth?.(shiftMonth(month, 1))}
              onPrevMonth={() => actions.setMonth?.(shiftMonth(month, -1))}
              onSelect={(date) => actions.selectDate?.(date)}
              selected={selectedDate}
              year={month.getFullYear()}
            />
            <footer className="today-calendar-legend" aria-label="日历标记说明">
              <span><i className="is-personal" />联系人日期</span>
              <span><i className="is-holiday" />节日</span>
            </footer>
          </GlassPanel>
          <div className="today-side-stack">
            <GlassPanel as="aside" className="today-day-panel" intensity="soft">
              <header className="today-day-panel__header">
                <div>
                  <span className="today-section-kicker">{selectedDate === today ? "今天" : "选中日期"}</span>
                  <h2>{dateLabel(selectedDate)}</h2>
                </div>
                <div className="today-day-panel__actions">
                  <Button size="sm" variant="secondary" disabled={!canEdit} onClick={() => actions.openEditor?.()}>添加日期</Button>
                  <Status label={`${selectedEvents.length} 项`} tone={selectedEvents.length ? "info" : "muted"} />
                </div>
              </header>
              <div className="today-day-panel__events">
                {snapshot.calendar?.status === "needs-agent" ? (
                  <Banner tone="info">先创建联系人，再把各自的重要日子保存在总日历里。</Banner>
                ) : null}
                {snapshot.calendar?.status === "invalid" ? (
                  <Banner tone="danger">纪念日数据暂时无法读取。为避免覆盖原有内容，编辑已暂停。</Banner>
                ) : null}
                <TodayEvents actions={actions} canEdit={canEdit} events={selectedEvents} />
              </div>
            </GlassPanel>
            <GlassPanel as="section" className="today-journal-panel" intensity="soft">
              <button
                type="button"
                className="today-journal-panel__action"
                aria-label="打开日记"
                onClick={() => actions.openJournal?.()}
              >
                <span className="today-journal-panel__copy">
                  <span className="today-section-kicker">AGENT JOURNAL</span>
                  <span className="today-journal-panel__title">日记</span>
                </span>
              </button>
            </GlassPanel>
          </div>
        </section>

        <section className="today-insight-grid" aria-label="今日概览">
          <GlassPanel as="article" className="today-insight-card today-cost-card" intensity="soft">
            <button
              type="button"
              className="today-cost-card__action"
              aria-label="打开用量记录"
              onClick={() => actions.openUsage?.()}
            >
              <div className="today-insight-head">
                <span className="today-section-kicker">USAGE</span>
                <Status label={ready ? "今日" : "等待数据"} tone={ready ? "success" : "muted"} />
              </div>
              <h2>今日成本</h2>
              <strong className="today-cost-value">{costLabel(snapshot.data?.summary?.today, ready)}</strong>
              <p>{costDetail(snapshot.data?.summary?.today, ready)}</p>
            </button>
          </GlassPanel>

          <GlassPanel as="article" className="today-insight-card today-activity-card" intensity="soft">
            <button
              type="button"
              className="today-activity-card__action"
              aria-label="打开调用记录"
              onClick={() => actions.openUsage?.()}
            >
              <div className="today-insight-head">
                <div>
                  <span className="today-section-kicker">RECENT</span>
                  <h2>最近活动</h2>
                </div>
              </div>
              {recentEvents.length ? (
                <div className="today-activity-list">
                  {recentEvents.map((event, index) => (
                    <div className="today-activity-row" key={`${event.timestamp || "activity"}-${index}`}>
                      <div>
                        <strong>{event.feature || "已识别调用"}</strong>
                        <span>{event.source || "调用记录"} · {dateTime(event.timestamp)}</span>
                      </div>
                      <b>{activityCost(event.amountCny)}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="today-activity-empty">{ready ? "还没有可显示的活动。" : "进入联系人后显示最近活动。"}</div>
              )}
            </button>
          </GlassPanel>
        </section>
      </div>
      </PageScaffold>
      <TodayEventEditor actions={actions} canEdit={canEdit} contacts={contacts} defaultContactId={defaultContactId} editor={snapshot.editor} selectedDate={selectedDate} />
    </>
  );
}
