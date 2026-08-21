import { useEffect, useState } from "react";
import { Button, Dialog, Empty, GlassPanel, Input, PageHeader, Select, Status, Switch, Textarea } from "suzu-design-system";

import { dateTime } from "../core/formatters.mjs";
import "./plans-page.css";

const PLAN_STAGES = [
  { title: "一次性", description: "再过几小时几分钟后触发" },
  { title: "每天", description: "每天固定时间，按 Cron 到点执行" },
  { title: "主体", description: "联系人或本机系统脚本" },
];

function clean(value) {
  return String(value ?? "").trim();
}

function fileName(value) {
  const source = clean(value).split(/[\\/]/u);
  return source[source.length - 1] || "系统脚本";
}

function dailyCronLabel(value) {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u.exec(clean(value));
  if (!match) return `Cron：${clean(value) || "未设置"}`;
  return `每天 ${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
}

function defaultDraft(contacts = []) {
  return {
    contactId: clean(contacts[0]?.id),
    description: "",
    hours: "0",
    minutes: "30",
    prompt: "",
    scheduleType: "once",
    scriptPath: "",
    targetType: "contact",
    time: "09:00",
  };
}

function scheduleTask(task) {
  const recurring = task?.kind === "cron";
  const target = task?.target || {};
  const enabled = task?.enabled !== false;
  const isScript = target.type === "script";
  const isOperation = target.type === "operation";
  const scope = isScript
    ? `系统脚本 · ${fileName(target.scriptPath)}`
    : isOperation
      ? target.name === "agent-journal"
        ? "Agent 日记 · 已开启联系人"
        : "软件内置操作"
      : target.contact?.name || "联系人会话";
  return {
    createdAt: dateTime(task?.createdAt),
    content: isScript ? clean(target.scriptPath) : isOperation ? scope : clean(target.prompt),
    contentLabel: isScript ? "脚本" : isOperation ? "操作" : "提示词",
    description: task?.description || (recurring ? "每日自动任务" : "一次性自动任务"),
    enabled,
    purpose: recurring ? dailyCronLabel(task?.cron) : dateTime(task?.dueAt),
    scope,
    status: enabled ? (recurring ? (isOperation ? "循环中" : "每天执行") : "等待触发") : "已关闭",
    statusTone: enabled ? "success" : "muted",
  };
}

function scheduleHistoryStatus(value) {
  const status = clean(value).toLowerCase();
  if (status === "running") return { label: "执行中", tone: "warning" };
  if (status === "queued") return { label: "已进入会话队列", tone: "warning" };
  if (status === "dispatched") return { label: "已提交给会话", tone: "success" };
  if (status === "completed") return { label: "已完成", tone: "success" };
  if (status === "failed") return { label: "执行失败", tone: "warning" };
  if (status === "interrupted") return { label: "已中断", tone: "muted" };
  return { label: "未投递", tone: "muted" };
}

function scheduleHistoryEntry(entry) {
  const details = scheduleTask(entry?.task);
  const status = scheduleHistoryStatus(entry?.status);
  return {
    ...details,
    finishedAt: clean(entry?.finishedAt) ? dateTime(entry.finishedAt) : "等待记录结果",
    status,
    triggeredAt: dateTime(entry?.triggeredAt),
  };
}

function PlansTaskCard({ actions, onRemove, task }) {
  const details = scheduleTask(task);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (event) => {
    const enabled = event.target.checked;
    if (!actions?.setEnabled) return;
    setPending(true);
    setError("");
    try {
      await actions.setEnabled({ enabled, id: task.id });
    } catch (actionError) {
      setError(clean(actionError?.message) || "无法更新计划状态。 ");
    } finally {
      setPending(false);
    }
  };

  return (
    <GlassPanel as="article" className={`plans-task-card${details.enabled ? "" : " is-disabled"}`} intensity="soft">
      <div className="plans-task-card__summary">
        <div className="plans-task-card__head">
          <h2>{details.description}</h2>
        </div>
        <dl className="plans-task-card__meta">
          <div>
            <dt>触发</dt>
            <dd>{details.purpose}</dd>
          </div>
          <div>
            <dt>主体</dt>
            <dd title={details.scope}>{details.scope}</dd>
          </div>
          <div>
            <dt>创建</dt>
            <dd>{details.createdAt}</dd>
          </div>
        </dl>
        <p className="plans-task-card__content" title={details.content}>
          <span>{details.contentLabel}</span>
          <span>{details.content || "未填写"}</span>
        </p>
      </div>
      <footer className="plans-task-card__footer">
        <Status label={details.status} tone={details.statusTone} />
        <label className="plans-task-card__switch">
          <Switch aria-label={`${details.description}${details.enabled ? "关闭" : "开启"}`} checked={details.enabled} disabled={pending} onChange={toggle} />
          <span>{details.enabled ? "已开启" : "已关闭"}</span>
        </label>
        <Button disabled={pending} onClick={() => onRemove(task)} size="sm" variant="danger">删除</Button>
      </footer>
      {error ? <p className="plans-task-card__error" role="alert">{error}</p> : null}
    </GlassPanel>
  );
}

function PlansHistoryCard({ entry }) {
  const details = scheduleHistoryEntry(entry);
  return (
    <GlassPanel as="article" className="plans-history-card" intensity="soft">
      <div className="plans-history-card__summary">
        <h3>{details.description}</h3>
        <dl className="plans-history-card__meta">
          <div>
            <dt>触发</dt>
            <dd>{details.triggeredAt}</dd>
          </div>
          <div>
            <dt>主体</dt>
            <dd title={details.scope}>{details.scope}</dd>
          </div>
          <div>
            <dt>记录</dt>
            <dd>{details.finishedAt}</dd>
          </div>
        </dl>
        <p className="plans-history-card__content" title={details.content}>
          <span>{details.contentLabel}</span>
          <span>{details.content || "未填写"}</span>
        </p>
      </div>
      <Status label={details.status.label} tone={details.status.tone} />
    </GlassPanel>
  );
}

function PlansHistoryDialog({ history, onClose }) {
  return (
    <Dialog
      footer={<div className="plans-editor-actions"><Button onClick={onClose} variant="secondary">关闭</Button></div>}
      onClose={onClose}
      open
      title="计划历史"
    >
      <div className="plans-history-dialog">
        <p>保留最近 100 次已触发计划，方便核对它是否进入了会话队列。</p>
        {history.length ? (
          <ol className="plans-history-dialog__list">
            {history.map((entry, index) => (
              <li key={entry?.id || `${entry?.triggeredAt || "history"}-${index}`}>
                <PlansHistoryCard entry={entry} />
              </li>
            ))}
          </ol>
        ) : <p className="plans-history-dialog__empty">尚无已触发的计划。</p>}
      </div>
    </Dialog>
  );
}

function PlansEmpty({ contacts, loading, onCreate }) {
  return (
    <Empty
      action={!loading ? <Button className="plans-create-button" onClick={onCreate} variant="secondary">新增计划</Button> : null}
      className="plans-empty"
      description={loading
        ? "正在读取本机保存的定时器与循环任务。"
        : contacts.length
          ? "为联系人设置一次性提醒、每日计划，或运行本机系统脚本。"
          : "还没有联系人；你仍可以先添加本机系统脚本计划。"}
      title={loading ? "正在读取自动任务" : "还没有自动任务"}
    />
  );
}

function PlanEditor({ actions, contacts, onClose }) {
  const [draft, setDraft] = useState(() => defaultDraft(contacts));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const contactTarget = draft.targetType === "contact";

  useEffect(() => {
    if (contacts.some((contact) => contact.id === draft.contactId)) return;
    setDraft((current) => ({ ...current, contactId: clean(contacts[0]?.id) }));
  }, [contacts, draft.contactId]);

  const change = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const chooseScript = async () => {
    if (!actions?.selectScript) return;
    setError("");
    try {
      const result = await actions.selectScript();
      if (!result?.canceled && result?.scriptPath) change("scriptPath", result.scriptPath);
    } catch (selectError) {
      setError(clean(selectError?.message) || "无法选择系统脚本。 ");
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!actions?.create) return;
    if (!contactTarget && !clean(draft.scriptPath)) {
      setError("请选择要执行的系统脚本。 ");
      return;
    }
    setPending(true);
    setError("");
    try {
      await actions.create(draft);
      onClose();
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存计划。 ");
    } finally {
      setPending(false);
    }
  };
  const footer = (
    <div className="plans-editor-actions">
      <Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button>
      <Button disabled={pending || (contactTarget && !contacts.length)} form="plansEditorForm" type="submit">{pending ? "正在保存…" : "添加计划"}</Button>
    </div>
  );

  return (
    <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title="新增计划">
      <form className="plans-editor-form" id="plansEditorForm" onSubmit={submit}>
        <label className="plans-editor-field">
          <span>类型</span>
          <Select
            fullWidth
            onChange={(scheduleType) => change("scheduleType", scheduleType)}
            options={[{ label: "一次性", value: "once" }, { label: "每天", value: "daily" }]}
            value={draft.scheduleType}
          />
        </label>
        {draft.scheduleType === "once" ? (
          <div className="plans-editor-delay" aria-label="一次性计划触发时间">
            <label className="plans-editor-field">
              <span>再过几小时</span>
              <Input inputMode="numeric" max="8760" min="0" onChange={(event) => change("hours", event.target.value)} required type="number" value={draft.hours} />
            </label>
            <label className="plans-editor-field">
              <span>再过几分钟</span>
              <Input inputMode="numeric" max="59" min="0" onChange={(event) => change("minutes", event.target.value)} required type="number" value={draft.minutes} />
            </label>
          </div>
        ) : (
          <label className="plans-editor-field">
            <span>每天几点</span>
            <Input onChange={(event) => change("time", event.target.value)} required type="time" value={draft.time} />
          </label>
        )}
        <label className="plans-editor-field">
          <span>主体</span>
          <Select
            fullWidth
            onChange={(targetType) => change("targetType", targetType)}
            options={[{ label: "联系人", value: "contact" }, { label: "系统", value: "system" }]}
            value={draft.targetType}
          />
        </label>
        {contactTarget ? (
          <>
            <label className="plans-editor-field plans-editor-field--wide">
              <span>联系人</span>
              <Select
                disabled={!contacts.length}
                fullWidth
                onChange={(contactId) => change("contactId", contactId)}
                options={contacts.map((contact) => ({ label: contact.name, value: contact.id }))}
                placeholder={contacts.length ? "选择联系人" : "还没有联系人"}
                value={draft.contactId}
              />
            </label>
            <label className="plans-editor-field plans-editor-field--wide">
              <span>提示词</span>
              <Textarea onChange={(event) => change("prompt", event.target.value)} required rows={5} value={draft.prompt} />
            </label>
          </>
        ) : (
          <div className="plans-editor-script plans-editor-field--wide">
            <div>
              <span>执行脚本</span>
              <small>支持 .cmd、.bat 和 .py，会在脚本所在目录运行。</small>
            </div>
            <div className="plans-editor-script__choice">
              <code title={draft.scriptPath}>{draft.scriptPath || "尚未选择脚本"}</code>
              <Button disabled={pending} onClick={chooseScript} size="sm" type="button" variant="secondary">选择脚本</Button>
            </div>
          </div>
        )}
        <label className="plans-editor-field plans-editor-field--wide">
          <span>说明 <small>可选</small></span>
          <Input maxLength="500" onChange={(event) => change("description", event.target.value)} placeholder={contactTarget ? "例如：晚饭后问问今天过得怎么样" : "例如：每日同步本机资料"} value={draft.description} />
        </label>
        {error ? <p className="plans-editor-error plans-editor-field--wide" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function DeletePlanDialog({ actions, onClose, task }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const remove = async () => {
    if (!actions?.remove) return;
    setPending(true);
    setError("");
    try {
      await actions.remove({ confirmed: true, id: task.id });
      onClose();
    } catch (removeError) {
      setError(clean(removeError?.message) || "无法删除计划。 ");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      footer={<div className="plans-editor-actions"><Button disabled={pending} onClick={onClose} variant="secondary">取消</Button><Button disabled={pending} onClick={remove} variant="danger">{pending ? "正在删除…" : "删除计划"}</Button></div>}
      onClose={pending ? () => {} : onClose}
      open
      title="删除计划？"
    >
      <div className="plans-delete-dialog">
        <p>{`“${scheduleTask(task).description}”会被永久删除，之后需要重新设置。`}</p>
        {error ? <p className="plans-editor-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

export function PlansPage({ actions = {}, snapshot = null }) {
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshot);
  const [editorOpen, setEditorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [removingTask, setRemovingTask] = useState(null);
  useEffect(() => { setCurrentSnapshot(snapshot); }, [snapshot]);
  const updateSnapshot = async (method, value) => {
    const action = actions?.[method];
    if (typeof action !== "function") return undefined;
    const result = await action(value);
    if (result?.snapshot) setCurrentSnapshot(result.snapshot);
    return result;
  };
  const pageActions = {
    ...actions,
    create: typeof actions.create === "function" ? (value) => updateSnapshot("create", value) : undefined,
    remove: typeof actions.remove === "function" ? (value) => updateSnapshot("remove", value) : undefined,
    setEnabled: typeof actions.setEnabled === "function" ? (value) => updateSnapshot("setEnabled", value) : undefined,
  };
  const loading = currentSnapshot === null;
  const tasks = Array.isArray(currentSnapshot?.tasks) ? currentSnapshot.tasks : [];
  const history = Array.isArray(currentSnapshot?.history) ? currentSnapshot.history : [];
  const contacts = Array.isArray(currentSnapshot?.contacts) ? currentSnapshot.contacts : [];

  return (
    <div className="plans-react-page">
      <PageHeader
        action={(
          <div className="plans-page-actions">
            <Button className="plans-history-button" disabled={loading} onClick={() => setHistoryOpen(true)} variant="secondary">计划历史</Button>
            <Button className="plans-create-button" disabled={loading} onClick={() => setEditorOpen(true)} variant="secondary">新增计划</Button>
          </div>
        )}
        eyebrow="PLANS"
        subtitle="管理本机保存的定时器、每日任务与系统脚本。"
        title="计划"
      />

      <ol className="plans-flow" aria-label="可创建的计划类型">
        {PLAN_STAGES.map((stage) => (
          <li className="plans-flow__step" key={stage.title}>
            <strong>{stage.title}</strong>
            <span>{stage.description}</span>
          </li>
        ))}
      </ol>

      {loading ? (
        <PlansEmpty contacts={contacts} loading onCreate={() => setEditorOpen(true)} />
      ) : tasks.length ? (
        <section className="plans-task-list" aria-label="已保存的自动任务">
          {tasks.map((task, index) => (
            <PlansTaskCard
              actions={pageActions}
              key={task?.id || `${task?.kind || "task"}-${index}`}
              onRemove={setRemovingTask}
              task={task}
            />
          ))}
        </section>
      ) : (
        <PlansEmpty contacts={contacts} loading={false} onCreate={() => setEditorOpen(true)} />
      )}

      {editorOpen ? <PlanEditor actions={pageActions} contacts={contacts} onClose={() => setEditorOpen(false)} /> : null}
      {historyOpen ? <PlansHistoryDialog history={history} onClose={() => setHistoryOpen(false)} /> : null}
      {removingTask ? <DeletePlanDialog actions={pageActions} onClose={() => setRemovingTask(null)} task={removingTask} /> : null}
    </div>
  );
}
