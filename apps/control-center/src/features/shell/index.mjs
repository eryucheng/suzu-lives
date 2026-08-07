import { dateTime, escapeHtml, money } from "../../core/formatters.mjs";
import { card, emptyBlock, pageIntro, status } from "../../components/panel.mjs";

export const icons = {
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"/></svg>',
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20c.4-3.3 2.3-5 5.5-5s5.1 1.7 5.5 5M16 5.5a3 3 0 0 1 0 5.8M17 15c2.1.4 3.2 1.9 3.5 4.5"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-11 4h4m-4 3h7"/></svg>',
  palette: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.2c1.2 0 1.7-1.4.8-2.2-.6-.6-.2-1.7.7-1.7H16a5 5 0 0 0 5-5c0-5-4-9-9-9Z"/><circle cx="7.5" cy="11.5" r=".8"/><circle cx="10.5" cy="7.5" r=".8"/><circle cx="15.5" cy="8.5" r=".8"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7V5Z"/><path d="M4 5v14"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6m8 4v6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.2 2.2-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3.1v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.2-2.2.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5v-3.1h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1L8.5 5l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3.7h3.1v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.2 2.2-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.4 1Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3 8 3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1 4"/><path d="M20 4v7h-7"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
};

export function initializeShellIcons() {
  document.querySelectorAll("[data-icon]").forEach((node) => {
    node.innerHTML = icons[node.dataset.icon] || "";
  });
}

function actionCard({ title, purpose, scope, stateLabel, tone, extra }) {
  return `<article class="action-card"><div class="action-card-head"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(purpose)}</p></div>${status(stateLabel, tone)}</div><div class="action-meta"><span>影响范围：${escapeHtml(scope)}</span>${extra ? `<span>${escapeHtml(extra)}</span>` : ""}</div></article>`;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const EVENT_TYPE_LABELS = { "纪念日": "纪念日", "生日": "生日", "日程": "日程", "其他": "其他", "节日": "节日" };

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validDateKey(value) {
  const source = String(value || "");
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateKey(date) === source ? source : "";
}

function monthKey(date) {
  return dateKey(date).slice(0, 7);
}

function monthDate(value, fallback) {
  const source = String(value || "");
  const match = source.match(/^(\d{4})-(\d{2})$/u);
  if (!match) return new Date(fallback.getFullYear(), fallback.getMonth(), 1);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return Number.isFinite(date.getTime()) ? date : new Date(fallback.getFullYear(), fallback.getMonth(), 1);
}

function shiftMonth(value, offset, fallback) {
  const date = monthDate(value, fallback);
  date.setMonth(date.getMonth() + offset);
  return monthKey(date);
}

function dateLabel(value) {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAYS[(date.getDay() + 6) % 7]}`;
}

function eventsForDate(events, value) {
  const recurring = value.slice(5);
  return (events || []).filter((event) => event.date === value || event.date === recurring);
}

function eventDateLabel(event) {
  return event.date.length === 5 ? "每年这一天" : "仅此一天";
}

function calendarCells(month, selected, today, events) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const leading = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const total = new Date(year, monthIndex + 1, 0).getDate();
  const cells = [];
  for (let index = 0; index < leading; index += 1) cells.push('<span class="today-calendar-blank" aria-hidden="true"></span>');
  for (let day = 1; day <= total; day += 1) {
    const value = dateKey(new Date(year, monthIndex, day));
    const dayEvents = eventsForDate(events, value).filter((event) => event.enabled);
    const classes = ["today-calendar-day", value === selected ? "selected" : "", value === today ? "today" : "", dayEvents.length ? "has-events" : ""].filter(Boolean).join(" ");
    const label = `${value}${dayEvents.length ? `，${dayEvents.map((event) => event.name).join("、")}` : ""}`;
    cells.push(`<button type="button" class="${classes}" data-today-date="${value}" aria-label="${escapeHtml(label)}"><span>${day}</span>${dayEvents.length ? `<i>${dayEvents.slice(0, 3).map((event) => `<b class="${event.source === "holiday" ? "holiday" : "personal"}"></b>`).join("")}</i>` : ""}</button>`);
  }
  while (cells.length < 42) cells.push('<span class="today-calendar-blank" aria-hidden="true"></span>');
  return cells.join("");
}

function selectedEventList(events, selected) {
  const values = eventsForDate(events, selected);
  if (!values.length) return '<div class="today-event-empty"><span>这一天还没有要记住的事。</span></div>';
  return `<div class="today-event-list">${values.map((event) => `<button type="button" class="today-event-item ${event.enabled ? "" : "paused"}" ${event.editable ? `data-edit-today-event="${escapeHtml(event.id)}"` : "disabled"}><span class="today-event-mark ${event.source === "holiday" ? "holiday" : "personal"}"></span><span class="today-event-copy"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(EVENT_TYPE_LABELS[event.type] || event.type)} · ${eventDateLabel(event)}${event.enabled ? "" : " · 已暂停"}</small></span>${event.editable ? '<span class="today-event-edit">设置</span>' : '<span class="today-event-static">节日</span>'}</button>`).join("")}</div>`;
}

function editorDate(event, selected) {
  if (!event?.date) return selected;
  return event.date.length === 5 ? `${selected.slice(0, 5)}${event.date}` : event.date;
}

function renderEventEditor(editor, selected) {
  const event = editor?.event || null;
  const date = editorDate(event, selected);
  const repeat = event?.date?.length === 5;
  return `<dialog id="todayEventDialog" class="today-event-dialog" aria-labelledby="todayEventDialogTitle"><div class="today-event-dialog__surface"><header><div><span class="reference-kicker">重要日期</span><h2 id="todayEventDialogTitle">${event ? "编辑纪念日" : "添加纪念日"}</h2><p>${event ? "调整这一天的名称、重复方式或显示状态。" : "把想记住的日子留在日历里。"}</p></div><button type="button" class="create-settings-close suzu-close-button" data-close-today-event aria-label="关闭"><span aria-hidden="true">×</span></button></header><form id="todayEventForm" class="today-event-form"><label class="wide"><span>名称</span><input name="name" value="${escapeHtml(event?.name || "")}" maxlength="80" required placeholder="例如：我们的纪念日"></label><label><span>日期</span><input name="date" type="date" value="${escapeHtml(date)}" required></label><label><span>分类</span><select name="type">${["纪念日", "生日", "日程", "其他"].map((type) => `<option value="${type}"${(event?.type || "纪念日") === type ? " selected" : ""}>${type}</option>`).join("")}</select></label><label class="today-event-check"><input name="repeat" type="checkbox"${repeat ? " checked" : ""}><span>每年重复</span></label><label class="today-event-check"><input name="enabled" type="checkbox"${event?.enabled !== false ? " checked" : ""}><span>显示在日历与今天</span></label><footer>${event ? '<button type="button" class="text-button today-event-delete" data-delete-today-event>删除</button>' : '<span></span>'}<div><button type="button" class="secondary-button" data-close-today-event>取消</button><button type="submit" class="primary-button">保存</button></div></footer></form></div></dialog>`;
}

function todayCostLabel(summary, ready) {
  if (!ready) return "—";
  const requests = Number(summary?.requestCount || 0);
  const known = Number(summary?.knownRequestCount || 0);
  if (requests && !known) return "暂未计价";
  const amount = Number(summary?.amountCny || 0);
  return amount === 0 ? "¥0.00" : money(amount);
}

function todayCostDetail(summary, ready) {
  if (!ready) return "选择联系人后显示";
  const requests = Number(summary?.requestCount || 0);
  const unknown = Number(summary?.unknownRequestCount || 0);
  if (!requests) return "今天还没有已识别调用";
  return `${requests} 次已识别调用${unknown ? ` · ${unknown} 次暂未计价` : ""}`;
}

function recentActivity(events, ready) {
  if (!ready) return '<div class="today-activity-empty">选择联系人后显示最近活动。</div>';
  const latest = Array.isArray(events) ? events.slice(-3).reverse() : [];
  if (!latest.length) return '<div class="today-activity-empty">还没有可显示的活动。</div>';
  return `<div class="today-activity-list">${latest.map((event) => `<div class="today-activity-row"><div class="today-activity-copy"><strong>${escapeHtml(event.feature || "已识别调用")}</strong><span>${escapeHtml(event.source || "调用记录")} · ${escapeHtml(dateTime(event.timestamp))}</span></div><b>${escapeHtml(money(event.amountCny))}</b></div>`).join("")}</div>`;
}

function renderTodayInsights(data) {
  const ready = data?.status === "ready";
  const summary = data?.summary?.today;
  return `<section class="today-insights" aria-label="今日概览">
    <article class="today-insight-card today-cost-card"><div><span class="reference-kicker">TODAY</span><h2>今日成本</h2></div><strong class="today-cost-value">${todayCostLabel(summary, ready)}</strong><p>${todayCostDetail(summary, ready)}</p><button type="button" class="quiet-link" data-open-admin="usage">查看用量 ${icons.arrow}</button></article>
    <article class="today-insight-card today-activity-card"><header><div><span class="reference-kicker">RECENT</span><h2>最近活动</h2></div><button type="button" class="quiet-link" data-open-admin="usage">全部记录 ${icons.arrow}</button></header>${recentActivity(data?.events, ready)}</article>
  </section>`;
}

function renderToday({ state }) {
  const now = new Date();
  const today = dateKey(now);
  const selected = validDateKey(state.todaySelectedDate) || today;
  const month = monthDate(state.todayMonth, new Date(`${selected}T12:00:00`));
  const events = state.todayCalendar?.events || [];
  const canEdit = state.todayCalendar?.canEdit === true;
  const selectedEvents = eventsForDate(events, selected);
  const monthTitle = `${month.getFullYear()}年${month.getMonth() + 1}月`;
  const warning = state.todayCalendar?.status === "needs-agent"
    ? '<div class="today-calendar-note">选择联系人后，就可以把纪念日保存在这里。</div>'
    : state.todayCalendar?.status === "invalid"
      ? '<div class="today-calendar-note warning">纪念日数据暂时无法读取，为避免覆盖原有内容，编辑已暂停。</div>'
      : "";
  return `${pageIntro("TODAY", "今天", "把重要的日子留在眼前。")}
    <section class="today-calendar-workspace">
      <section class="today-calendar-board" aria-label="日历">
        <header class="today-calendar-head"><div><span class="reference-kicker">CALENDAR</span><h2>${monthTitle}</h2></div><div class="today-calendar-controls"><button type="button" class="icon-button" data-today-month="previous" aria-label="上个月">‹</button><button type="button" class="secondary-button today-calendar-today" data-today-go-today>今天</button><button type="button" class="icon-button" data-today-month="next" aria-label="下个月">›</button></div></header>
        <div class="today-calendar-weekdays">${WEEKDAYS.map((day) => `<span>${day}</span>`).join("")}</div>
        <div class="today-calendar-grid">${calendarCells(month, selected, today, events)}</div>
        <footer class="today-calendar-legend"><span><i class="personal"></i>纪念日与安排</span><span><i class="holiday"></i>节日</span></footer>
      </section>
      <aside class="today-day-panel"><header><div><span class="reference-kicker">${selected === today ? "今天" : "选中日期"}</span><h2>${dateLabel(selected)}</h2></div><button type="button" class="primary-button" data-add-today-event ${canEdit ? "" : "disabled"}>添加纪念日</button></header>${warning}${selectedEventList(selectedEvents, selected)}</aside>
    </section>${renderTodayInsights(state.data)}${renderEventEditor(state.todayEventEditor, selected)}`;
}

function scheduleTaskCard(task) {
  const recurring = task?.kind === "cron";
  const target = task?.target || {};
  const purpose = recurring
    ? `循环：${task.cron || "未设置 Cron"}`
    : `触发时间：${dateTime(task.dueAt)}`;
  const scope = recurring
    ? target.name === "traveling-merchant" ? "远行商人 · 已开启会话" : "软件自动任务"
    : target.sessionId ? `主动关心 · 会话 ${target.sessionId}` : "本机会话";
  return actionCard({
    title: task.description || (recurring ? "循环自动任务" : "一次性自动任务"),
    purpose,
    scope,
    stateLabel: recurring ? "循环中" : "等待触发",
    tone: "ready",
    extra: `创建于 ${dateTime(task.createdAt)}`,
  });
}

function renderPlans({ state }) {
  const snapshot = state.scheduleSnapshot;
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const schedule = snapshot === null
    ? emptyBlock(icons.spark, "正在读取自动任务", "Suzu 正在读取本机保存的定时器与循环任务。")
    : tasks.length
      ? `<section class="action-list">${tasks.map(scheduleTaskCard).join("")}</section>`
      : emptyBlock(icons.spark, "还没有自动任务", "主动关心和远行商人的自动任务会显示在这里。");
  return `${pageIntro("PLANS", "计划，不只是待办列表", "这里会显示 Suzu 本机保存的定时器和循环任务。")}<section class="plan-rail"><div class="plan-node"><b>一次性</b><span>到时间后触发一次</span></div><div class="plan-line"></div><div class="plan-node future"><b>循环</b><span>按 Cron 到点执行</span></div><div class="plan-line"></div><div class="plan-node future"><b>投递</b><span>按能力设置决定会话范围</span></div></section>${schedule}`;
}
function renderActions() {
  return `${pageIntro("ACTIONS", "外部行动先让你看见，再让它发生", "行动只有在目的、影响范围与确认状态清晰时才值得执行。")}<div class="action-legend">${status("建议中", "muted")}${status("等待确认", "warning")}${status("执行中", "progress")}${status("已完成", "ready")}${status("失败可恢复", "danger")}</div><section class="action-list">${actionCard({ title: "等待可审批的行动", purpose: "外部渠道、设备和自动化准备好后，会在这里出现真实行动。", scope: "还没有可用来源", stateLabel: "准备中", tone: "muted", extra: "预计费用 / 数据访问：暂无数据" })}${actionCard({ title: "行动记录", purpose: "用于回看已确认行动的结果与恢复路径。", scope: "暂无执行记录", stateLabel: "只读", tone: "muted", extra: "只显示实际发生过的行动" })}</section>`;
}

export function renderShellView(view, context) {
  if (view === "today") return renderToday(context);
  if (view === "plans") return renderPlans(context);
  return renderActions();
}

export function bindShellEvents(context) {
  const { setAdminTab, setView, state } = context;
  document.querySelectorAll("[data-open-admin]").forEach((button) => button.addEventListener("click", () => {
    setAdminTab(button.dataset.openAdmin);
    setView("admin");
  }));
  if (state.view !== "today") return;

  const now = new Date();
  const current = dateKey(now);
  const selected = validDateKey(state.todaySelectedDate) || current;
  document.querySelectorAll("[data-today-month]").forEach((button) => button.addEventListener("click", () => {
    state.todayMonth = shiftMonth(state.todayMonth || selected.slice(0, 7), button.dataset.todayMonth === "previous" ? -1 : 1, now);
    context.render();
  }));
  document.querySelector("[data-today-go-today]")?.addEventListener("click", () => {
    state.todayMonth = current.slice(0, 7);
    state.todaySelectedDate = current;
    context.render();
  });
  document.querySelectorAll("[data-today-date]").forEach((button) => button.addEventListener("click", () => {
    state.todaySelectedDate = button.dataset.todayDate;
    state.todayMonth = button.dataset.todayDate.slice(0, 7);
    context.render();
  }));
  document.querySelector("[data-add-today-event]")?.addEventListener("click", () => {
    state.todayEventEditor = { event: null };
    context.render();
  });
  document.querySelectorAll("[data-edit-today-event]").forEach((button) => button.addEventListener("click", () => {
    const event = (state.todayCalendar?.events || []).find((item) => item.id === button.dataset.editTodayEvent && item.editable);
    if (!event) return;
    state.todayEventEditor = { event };
    context.render();
  }));

  const dialog = document.querySelector("#todayEventDialog");
  if (!dialog) return;
  if (state.todayEventEditor && !dialog.open) dialog.showModal();
  document.querySelectorAll("[data-close-today-event]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => {
    if (!state.todayEventEditor) return;
    state.todayEventEditor = null;
    context.render();
  }, { once: true });
  document.querySelector("#todayEventForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      state.todayCalendar = await context.api.todayCalendar.saveEvent({
        id: state.todayEventEditor?.event?.id || "",
        name: form.get("name"),
        date: form.get("date"),
        type: form.get("type"),
        repeat: form.get("repeat") === "on",
        enabled: form.get("enabled") === "on",
      });
      state.todayEventEditor = null;
      dialog.close();
      context.setNotice("纪念日已保存。");
      context.render();
    } catch (error) {
      context.setNotice(error?.message || String(error));
    }
  });
  document.querySelector("[data-delete-today-event]")?.addEventListener("click", async () => {
    const event = state.todayEventEditor?.event;
    if (!event || !window.confirm(`删除“${event.name}”？`)) return;
    try {
      state.todayCalendar = await context.api.todayCalendar.removeEvent(event.id);
      state.todayEventEditor = null;
      dialog.close();
      context.setNotice("纪念日已删除。");
      context.render();
    } catch (error) {
      context.setNotice(error?.message || String(error));
    }
  });
}
