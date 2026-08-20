import { useEffect, useState } from "react";
import { Button, Dialog, Drawer, Empty, GlassPanel, Input, Select, Status, Textarea } from "suzu-design-system";

import "./api-connections-ui.css";

const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

const CONNECTION_TYPE_OPTIONS = Object.freeze([
  { label: "TTS API", value: "tts-api" },
  { label: "ASR API", value: "asr-api" },
  { label: "OpenAI 兼容", value: "openai-compatible" },
  { label: "其他 API", value: "generic-api" },
]);

// 服务商预设：选中只自动填写服务地址；"自定义"留给用户自己的地址。
const ENDPOINT_PRESETS = Object.freeze([
  { type: "openai-compatible", value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { type: "openai-compatible", value: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { type: "openai-compatible", value: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { type: "openai-compatible", value: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { type: "openai-compatible", value: "tongyi", label: "通义（兼容模式）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { type: "openai-compatible", value: "ollama", label: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
]);
const PRESET_CUSTOM = "custom";
const PRESET_BASE_URLS = new Set(ENDPOINT_PRESETS.map((item) => item.baseUrl).filter(Boolean));

const DEFAULT_CONNECTION = Object.freeze({
  apiKey: "",
  baseUrl: "",
  editEndpoint: "/images/edits",
  editExtraBody: {},
  extraBody: {},
  generationEndpoint: "/images/generations",
  id: "",
  inputFidelity: "",
  model: "",
  name: "",
  outputFormat: "",
  quality: "",
  timeoutMs: 180000,
  type: "tts-api",
});

function clean(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function remarkKey(value) {
  return clean(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function Field({ children, className = "", hint = "", label }) {
  return (
    <label className={["api-connection-field", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function InlineError({ children }) {
  return children ? <p className="api-connection-inline-error" role="alert">{children}</p> : null;
}

function parseExtraJson(value, label) {
  const text = clean(value);
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}必须是有效 JSON 对象。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象。`);
  return parsed;
}

function connectionDraft(connection = null) {
  const value = connection || DEFAULT_CONNECTION;
  const type = clean(value.type) || "dashscope";
  return {
    apiKey: "",
    baseUrl: clean(value.baseUrl) || (type === "dashscope" ? DEFAULT_DASHSCOPE_BASE_URL : ""),
    editEndpoint: clean(value.editEndpoint) || "/images/edits",
    editExtraBody: JSON.stringify(value.editExtraBody || {}, null, 2),
    extraBody: JSON.stringify(value.extraBody || {}, null, 2),
    generationEndpoint: clean(value.generationEndpoint) || "/images/generations",
    id: clean(value.id),
    inputFidelity: clean(value.inputFidelity),
    model: clean(value.model),
    name: clean(value.name),
    outputFormat: clean(value.outputFormat),
    quality: clean(value.quality),
    timeoutMs: String(value.timeoutMs || 180000),
    type,
  };
}

function serviceLabel(connection) {
  return clean(connection?.service)
    || CONNECTION_TYPE_OPTIONS.find((item) => item.value === clean(connection?.type))?.label
    || "API";
}

function credentialStatus(connection) {
  if (connection?.configured === true) return { label: "密钥已保存", tone: "success" };
  if (clean(connection?.credentialStatus) === "unreadable") return { label: "密钥需要重新保存", tone: "warning" };
  if (clean(connection?.credentialStatus) === "encryption-unavailable") return { label: "系统无法加密保存", tone: "warning" };
  return { label: "未填写密钥", tone: "muted" };
}

function hasDuplicateRemark(connections, draft, current = null) {
  const key = remarkKey(draft?.name);
  if (!key) return false;
  const duplicate = connections.some((connection) => clean(connection?.id) !== clean(draft?.id) && remarkKey(connection?.name) === key);
  return duplicate && remarkKey(current?.name) !== key;
}

function ApiConnectionEditor({ connection, connections, onClose, onSave }) {
  const [draft, setDraft] = useState(() => connectionDraft(connection));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const editing = Boolean(connection?.id);
  const openAiCompatible = draft.type === "openai-compatible";

  useEffect(() => {
    setDraft(connectionDraft(connection));
    setError("");
  }, [connection]);

  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const changeType = (type) => setDraft((current) => {
    // 切换服务类型时，若地址还是预设/默认值，则按新类型重置；用户自定义的地址保留。
    const baseUrl = clean(current.baseUrl);
    const reset = !baseUrl || PRESET_BASE_URLS.has(baseUrl) || baseUrl === DEFAULT_DASHSCOPE_BASE_URL;
    return {
      ...current,
      type,
      baseUrl: reset ? (type === "dashscope" ? DEFAULT_DASHSCOPE_BASE_URL : "") : baseUrl,
    };
  });
  const presetOptions = () => {
    const options = ENDPOINT_PRESETS.filter((item) => item.type === draft.type).map((item) => ({ label: item.label, value: item.value }));
    return draft.type === "generic-api" ? options : [...options, { label: "自定义", value: PRESET_CUSTOM }];
  };
  const currentPreset = () => {
    const baseUrl = clean(draft.baseUrl);
    const match = ENDPOINT_PRESETS.find((item) => item.type === draft.type && item.baseUrl === baseUrl);
    return match ? match.value : PRESET_CUSTOM;
  };
  const changePreset = (value) => {
    const preset = ENDPOINT_PRESETS.find((item) => item.type === draft.type && item.value === value);
    if (!preset?.baseUrl) return;
    setDraft((current) => ({ ...current, baseUrl: preset.baseUrl }));
  };
  const save = async (event) => {
    event.preventDefault();
    if (!onSave || pending) return;
    const remark = clean(draft.name);
    if (!remark) {
      setError("请填写 API 备注。 ");
      return;
    }
    if (hasDuplicateRemark(connections, draft, connection)) {
      setError(`API 备注“${remark}”已经存在，请换一个。`);
      return;
    }
    setPending(true);
    setError("");
    try {
      await onSave({
        ...draft,
        apiKey: draft.apiKey,
        editExtraBody: parseExtraJson(draft.editExtraBody, "编辑附加参数 JSON"),
        extraBody: parseExtraJson(draft.extraBody, "生成附加参数 JSON"),
        name: remark,
        timeoutMs: Number(draft.timeoutMs),
      });
      onClose();
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存 API。 ");
    } finally {
      setPending(false);
    }
  };

  const footer = (
    <div className="api-connection-dialog-actions">
      <Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button>
      <Button disabled={pending} form="apiConnectionForm" type="submit">{pending ? "正在保存…" : editing ? "保存修改" : "保存 API"}</Button>
    </div>
  );

  return (
    <Dialog footer={footer} onClose={pending ? () => {} : onClose} open surface="solid" title={editing ? `编辑 ${connection.name}` : "新建 API"}>
      <form className="api-connection-editor" id="apiConnectionForm" onSubmit={save}>
        <p className="api-connection-dialog-copy">这里只保存 API 的备注、地址和密钥；具体哪项能力使用它，会在那项能力自己的选择抽屉中决定。</p>
        <div className="api-connection-form-grid">
          <Field className="api-connection-field--wide" hint="备注会显示在能力选择抽屉里，不能和已有 API 重名。" label="备注名称">
            <Input disabled={pending} maxLength="80" onChange={(event) => change("name", event.target.value)} placeholder="例如：TTS api、生图 api" required value={draft.name} />
          </Field>
          <Field label="服务类型">
            <Select disabled={pending} fullWidth onChange={changeType} options={[
              ...CONNECTION_TYPE_OPTIONS,
              ...(draft.type === "dashscope" ? [{ label: "DashScope 原生协议（已有连接）", value: "dashscope" }] : []),
            ]} value={draft.type} />
          </Field>
          <Field label="API Key">
            <Input autoComplete="new-password" disabled={pending} maxLength="1000" onChange={(event) => change("apiKey", event.target.value)} placeholder={editing ? "留空则保留当前密钥" : "新建时必填"} required={!editing} type="password" value={draft.apiKey} />
          </Field>
          {!["generic-api", "tts-api", "asr-api"].includes(draft.type) ? (
            <Field className="api-connection-field--wide" hint={currentPreset() === PRESET_CUSTOM ? "选择预设会自动填写服务地址；" : ""} label="服务商">
              <Select disabled={pending} fullWidth onChange={changePreset} options={presetOptions()} value={currentPreset()} />
            </Field>
          ) : null}
          <Field className="api-connection-field--wide" hint={draft.type === "dashscope" ? "默认是官方地址；也可以填写兼容网关。" : draft.type === "generic-api" ? "服务商没有固定地址时可以留空。" : draft.type === "tts-api" ? "填写 TTS 服务的完整地址，可以是官方接口或自建中转。" : draft.type === "asr-api" ? "填写语音识别服务的完整地址，可以是官方接口或自建中转。" : "填写服务商提供的完整 Base URL。"} label={draft.type === "generic-api" ? "服务地址（可选）" : "服务地址"}>
            <Input disabled={pending} maxLength="500" onChange={(event) => change("baseUrl", event.target.value)} placeholder={draft.type === "dashscope" ? DEFAULT_DASHSCOPE_BASE_URL : "https://api.example.com/v1"} required={openAiCompatible || draft.type === "tts-api" || draft.type === "asr-api"} value={draft.baseUrl} />
          </Field>
          <Field className="api-connection-field--wide" hint={openAiCompatible || draft.type === "asr-api" ? "这个连接的默认模型；能力可以在自己的设置里覆盖。" : "可选；能力有自己的模型设置时会优先使用能力设置。"} label={openAiCompatible || draft.type === "asr-api" ? "默认模型" : "默认模型（可选）"}>
            <Input disabled={pending} maxLength="160" onChange={(event) => change("model", event.target.value)} placeholder={draft.type === "tts-api" ? "填写服务商提供的 TTS 模型名" : draft.type === "asr-api" ? "填写服务商提供的识别模型名" : "例如：deepseek-chat、gpt-4.1-mini"} required={openAiCompatible || draft.type === "asr-api"} value={draft.model} />
          </Field>
        </div>
        {openAiCompatible ? (
          <details className="api-connection-advanced">
            <summary><span>进阶设置</span><small>只有 API 文档要求时才需要修改</small></summary>
            <p>通常保留默认值即可；这些字段仅描述这个 API 的请求格式，不会为任何能力自动启用它。</p>
            <div className="api-connection-form-grid">
              <Field label="生成地址"><Input disabled={pending} maxLength="300" onChange={(event) => change("generationEndpoint", event.target.value)} value={draft.generationEndpoint} /></Field>
              <Field label="编辑地址"><Input disabled={pending} maxLength="300" onChange={(event) => change("editEndpoint", event.target.value)} value={draft.editEndpoint} /></Field>
              <Field label="质量（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("quality", event.target.value)} value={draft.quality} /></Field>
              <Field label="输出格式（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("outputFormat", event.target.value)} value={draft.outputFormat} /></Field>
              <Field label="参考保真（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("inputFidelity", event.target.value)} value={draft.inputFidelity} /></Field>
              <Field label="请求超时（毫秒）"><Input disabled={pending} max="600000" min="1000" onChange={(event) => change("timeoutMs", event.target.value)} type="number" value={draft.timeoutMs} /></Field>
              <Field className="api-connection-field--wide" label="生成附加参数 JSON"><Textarea disabled={pending} maxLength="50000" onChange={(event) => change("extraBody", event.target.value)} spellCheck={false} value={draft.extraBody} /></Field>
              <Field className="api-connection-field--wide" label="编辑附加参数 JSON"><Textarea disabled={pending} maxLength="50000" onChange={(event) => change("editExtraBody", event.target.value)} spellCheck={false} value={draft.editExtraBody} /></Field>
            </div>
          </details>
        ) : null}
        <InlineError>{error}</InlineError>
      </form>
    </Dialog>
  );
}

function ApiConnectionDeleteDialog({ connection, onClose, onConfirm }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const remove = async () => {
    if (!onConfirm || pending) return;
    setPending(true);
    setError("");
    try {
      await onConfirm(connection.id);
      onClose();
    } catch (removeError) {
      setError(clean(removeError?.message) || "无法移除 API。 ");
    } finally {
      setPending(false);
    }
  };
  const footer = <div className="api-connection-dialog-actions"><Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button><Button disabled={pending} onClick={remove} type="button" variant="danger">{pending ? "正在移除…" : "移除"}</Button></div>;
  return <Dialog footer={footer} onClose={pending ? () => {} : onClose} open surface="solid" title="移除 API"><div className="api-connection-delete-dialog"><p>{`移除“${connection.name || "这个 API"}”？引用它的能力会回到未选择状态。`}</p><InlineError>{error}</InlineError></div></Dialog>;
}

function ApiConnectionRow({ connection, onEdit, onRemove }) {
  const status = credentialStatus(connection);
  const baseUrl = clean(connection?.baseUrl);
  const model = clean(connection?.model);
  return (
    <article className="api-connection-row">
      <div className="api-connection-row__copy">
        <div className="api-connection-row__title"><strong>{connection.name || "未命名 API"}</strong><Status label={status.label} tone={status.tone} /></div>
        <span>{serviceLabel(connection)}{baseUrl ? ` · ${baseUrl}` : " · 未填写服务地址"}{model ? ` · ${model}` : ""}</span>
      </div>
      <div className="api-connection-row__actions">
        <Button onClick={() => onEdit(connection)} size="md" type="button" variant="secondary">编辑</Button>
        <Button onClick={() => onRemove(connection)} size="md" type="button" variant="ghost">移除</Button>
      </div>
    </article>
  );
}

/** Settings owns only the reusable connection library. Capability binding is deliberately elsewhere. */
export function ApiConnectionsSettings({ actions = {}, snapshot = {} }) {
  const connections = list(snapshot?.connections);
  const [editing, setEditing] = useState(undefined);
  const [removing, setRemoving] = useState(null);
  return (
    <section className="api-connections-settings">
      <GlassPanel as="section" className="api-connections-settings__card" intensity="soft">
        <header className="api-connections-settings__header">
          <div>
            <span>API CONNECTIONS</span>
            <h2>API 连接</h2>
            <p>统一保存可复用的 API。备注在能力选择时显示；这里不决定任何能力使用哪一个 API。</p>
          </div>
          <Button onClick={() => setEditing(null)} size="md" type="button">新建 API</Button>
        </header>
        {connections.length ? (
          <div className="api-connections-settings__list">
            {connections.map((connection) => <ApiConnectionRow connection={connection} key={connection.id} onEdit={setEditing} onRemove={setRemoving} />)}
          </div>
        ) : <Empty action={<Button onClick={() => setEditing(null)} size="md" type="button">新建第一个 API</Button>} className="api-connections-settings__empty" description="添加 API 后，需要它的能力会在自己的设置里通过抽屉选择这条备注。" title="还没有 API 连接" />}
      </GlassPanel>
      {editing !== undefined ? <ApiConnectionEditor connection={editing} connections={connections} key={editing?.id || "new"} onClose={() => setEditing(undefined)} onSave={actions.saveApiConnection} /> : null}
      {removing ? <ApiConnectionDeleteDialog connection={removing} onClose={() => setRemoving(null)} onConfirm={actions.removeApiConnection} /> : null}
    </section>
  );
}

/** A capability owns its own binding. This drawer only selects from the shared connection library. */
export function ApiConnectionPicker({ connections = [], detail = "", onManage, onSelect, selectedId = "", title = "选择 API" }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selected = connections.find((connection) => clean(connection?.id) === clean(selectedId)) || null;
  const choose = async (connectionId) => {
    if (!onSelect || pending) return;
    setPending(true);
    setError("");
    try {
      await onSelect(connectionId);
      setOpen(false);
    } catch (selectError) {
      setError(clean(selectError?.message) || "无法选择这个 API。 ");
    } finally {
      setPending(false);
    }
  };
  const manage = () => {
    setOpen(false);
    onManage?.();
  };
  return (
    <div className="api-connection-picker">
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)} type="button" variant="secondary">{selected?.name || "选择 API"}</Button>
      <Drawer onClose={pending ? () => {} : () => setOpen(false)} open={open} title={title}>
        <div className="api-connection-picker__drawer">
          {detail ? <p>{detail}</p> : null}
          {connections.length ? (
            <div className="api-connection-picker__list">
              {connections.map((connection) => {
                const status = credentialStatus(connection);
                const isSelected = clean(connection.id) === clean(selectedId);
                return (
                  <article className={`api-connection-picker__row${isSelected ? " is-selected" : ""}`} key={connection.id}>
                    <div><strong>{connection.name || "未命名 API"}</strong><span>{serviceLabel(connection)}{clean(connection.baseUrl) ? ` · ${connection.baseUrl}` : ""}</span><Status label={status.label} tone={status.tone} /></div>
                    <Button aria-pressed={isSelected} disabled={pending || connection.configured !== true} onClick={() => choose(connection.id)} size="sm" type="button" variant={isSelected ? "primary" : "secondary"}>{isSelected ? "正在使用" : "使用"}</Button>
                  </article>
                );
              })}
            </div>
          ) : <Empty action={<Button onClick={manage} size="md" type="button">前往 API 设置</Button>} className="api-connection-picker__empty" description="先在设置 → API 新建一条连接，之后它会按备注显示在这里。" title="还没有可选择的 API" />}
          {selected ? <Button disabled={pending} onClick={() => choose("")} size="md" type="button" variant="ghost">不使用 API</Button> : null}
          {connections.length ? <Button onClick={manage} size="md" type="button" variant="secondary">管理 API</Button> : null}
          <InlineError>{error}</InlineError>
        </div>
      </Drawer>
    </div>
  );
}
