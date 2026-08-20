import { useEffect, useState } from "react";
import { Select } from "suzu-design-system";

const STEPS = [
  ["main-model", "主模型"],
  ["contact", "新建联系人"],
  ["persona", "填写人设"],
  ["ready", "开始使用"],
];

const PREVIOUS_STEP = {
  contact: "main-model",
  persona: "contact",
  ready: "persona",
};

const PROTOCOL_OPTIONS = [
  { label: "Anthropic Messages", value: "anthropic-messages" },
  { label: "OpenAI Chat Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
];

function modelDraft(model = {}) {
  const selected = model.providers?.find((item) => item.id === model.providerId) || model.providers?.[0] || {};
  return {
    apiKey: "",
    baseUrl: String(model.baseUrl || selected.baseUrl || ""),
    model: String(model.model || selected.model || ""),
    provider: String(model.providerId || selected.id || "deepseek"),
    protocol: String(model.protocol || selected.protocol || "anthropic-messages"),
  };
}

function OnboardingError({ error }) {
  return error ? <p className="onboarding-error" role="alert">{error}</p> : null;
}

function MainModelStep({ snapshot, actions }) {
  const model = snapshot.textModel;
  const [draft, setDraft] = useState(() => modelDraft(model));

  useEffect(() => {
    setDraft(modelDraft(model));
  }, [model.baseUrl, model.model, model.protocol, model.providerId, model.ready]);

  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const changeProvider = (providerId) => {
    const selected = model.providers?.find((item) => item.id === providerId) || {};
    setDraft((current) => ({
      ...current,
      baseUrl: String(selected.baseUrl || ""),
      model: String(selected.model || ""),
      protocol: String(selected.protocol || "anthropic-messages"),
      provider: providerId,
    }));
  };
  const submit = (event) => {
    event.preventDefault();
    void actions.saveMainModel(draft);
  };
  return (
    <section className="onboarding-body onboarding-body--model">
      <span className="reference-kicker">1 / 4 · MAIN MODEL</span>
      <h2>先让 Suzu 能聊天</h2>
      <p>在这里直接填写主模型服务。保存后，这项配置会作为 Suzu Agent 的默认文字模型。</p>
      <form className="onboarding-form" onSubmit={submit}>
        <div className="onboarding-model-grid">
          <label><span>服务</span><Select ariaLabel="文字模型服务" className="onboarding-provider-select" fullWidth onChange={changeProvider} options={model.providers.map((item) => ({ label: item.label, value: item.id }))} value={draft.provider} /></label>
          <label><span>接口协议</span>{draft.provider === "deepseek" ? <input disabled value="OpenAI Chat Completions（原生）" /> : <Select ariaLabel="接口协议" fullWidth onChange={(value) => change("protocol", value)} options={PROTOCOL_OPTIONS} value={draft.protocol} />}</label>
          <label className="onboarding-model-grid__wide"><span>服务地址</span><input autoComplete="url" maxLength={500} onChange={(event) => change("baseUrl", event.currentTarget.value)} placeholder="https://api.example.com" required value={draft.baseUrl} /></label>
          <label><span>API Key</span><input autoComplete="new-password" maxLength={1000} name="apiKey" onChange={(event) => change("apiKey", event.currentTarget.value)} placeholder={model.ready ? "已保存；重新填写才会替换" : "填写所选服务的 API Key"} required={!model.ready} type="password" value={draft.apiKey} /></label>
          <label><span>主模型</span><input autoComplete="off" maxLength={200} onChange={(event) => change("model", event.currentTarget.value)} placeholder="填写模型标识" required value={draft.model} /></label>
        </div>
        <p className="onboarding-hint">服务地址需要是 HTTPS；本机回环地址可以使用 HTTP。模型标识可按服务商文档直接填写，之后也能在“设置 → 主模型”修改。</p>
        <OnboardingError error={snapshot.error} />
        <div className="onboarding-actions"><button className="secondary-button" disabled={!model.ready} onClick={() => actions.continue("contact")} type="button">沿用当前配置</button><button className="primary-button">保存并继续</button></div>
      </form>
    </section>
  );
}

function ContactStep({ snapshot, actions }) {
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">2 / 4 · CONTACT</span>
      <h2>创建第一个联系人</h2>
      <p>前往对话页，在联系人栏右上角点“＋”。给她写一个备注后，Suzu 会创建独立的资料与会话空间。</p>
      <OnboardingError error={snapshot.error} />
      <div className="onboarding-actions"><button className="primary-button" onClick={actions.openContactCreate} type="button">去点“＋”新建联系人</button></div>
    </section>
  );
}

function PersonaStep({ snapshot, actions }) {
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">3 / 4 · PERSONA</span>
      <h2>写下她的人设</h2>
      <p>前往“关系 → 相处设定”，在“人格与相处方式（persona.md）”中写她是谁、如何说话，以及你们怎样相处。保存后会自动进入最后一步。</p>
      <OnboardingError error={snapshot.error} />
      <div className="onboarding-actions"><button className="primary-button" onClick={actions.openPersonaSetup} type="button">去填写人设</button></div>
    </section>
  );
}

function ReadyStep({ snapshot, actions }) {
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">4 / 4 · READY</span>
      <h2>现在可以开始相处了</h2>
      <p>主模型、联系人和人设都已准备好。之后随时可以在设置、关系和能力页面继续调整。</p>
      <OnboardingError error={snapshot.error} />
      <div className="onboarding-actions"><button className="primary-button" onClick={() => { void actions.complete(); }} type="button">开始聊天</button></div>
    </section>
  );
}

function StepBody({ snapshot, actions }) {
  if (snapshot.step === "ready") return <ReadyStep actions={actions} snapshot={snapshot} />;
  if (snapshot.step === "persona") return <PersonaStep actions={actions} snapshot={snapshot} />;
  if (snapshot.step === "contact") return <ContactStep actions={actions} snapshot={snapshot} />;
  return <MainModelStep actions={actions} snapshot={snapshot} />;
}

export function OnboardingDialog({ onboarding = null }) {
  const snapshot = onboarding?.snapshot;
  const actions = onboarding?.actions;
  if (!snapshot || !actions) return null;
  const activeIndex = Math.max(STEPS.findIndex(([id]) => id === snapshot.step), 0);
  const previous = PREVIOUS_STEP[snapshot.step];
  return (
    <div className="onboarding-overlay">
      <section aria-labelledby="onboardingTitle" aria-modal="true" className="onboarding-dialog" role="dialog">
        <header className="onboarding-header"><div><span className="reference-kicker">SUZU LIVES</span><h1 id="onboardingTitle">开始使用</h1></div><button aria-label="稍后设置" className="onboarding-close suzu-close-button" onClick={actions.close} title="稍后设置" type="button">×</button></header>
        <ol aria-label="首次设置步骤" className="onboarding-steps">{STEPS.map(([id, label], index) => <li className={`${index === activeIndex ? "active" : ""}${index < activeIndex ? " complete" : ""}`} key={id}><span>{index + 1}</span><b>{label}</b></li>)}</ol>
        <StepBody actions={actions} snapshot={snapshot} />
        <footer className="onboarding-footer">{previous ? <button className="text-button" onClick={() => actions.back(previous)} type="button">返回上一步</button> : <span />}<button className="text-button" onClick={actions.close} type="button">稍后设置</button></footer>
      </section>
    </div>
  );
}
