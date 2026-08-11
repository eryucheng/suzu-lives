import { useState } from "react";

const STEPS = [
  ["text-model", "文字模型"],
  ["multimodal", "多模态 API"],
  ["projects", "联系人目录"],
  ["contact", "首个联系人"],
];

const PREVIOUS_STEP = {
  multimodal: "text-model",
  projects: "multimodal",
  contact: "projects",
};

function OnboardingError({ error }) {
  return error ? <p className="onboarding-error" role="alert">{error}</p> : null;
}

function TextModelStep({ snapshot, actions }) {
  const model = snapshot.textModel;
  const [provider, setProvider] = useState(model.providerId);
  const [apiKey, setApiKey] = useState("");
  const submit = (event) => {
    event.preventDefault();
    void actions.saveTextModel({ apiKey, provider });
  };
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">1 / 4 · TEXT MODEL</span>
      <h2>先让 Claude Code 能聊天</h2>
      <p>{model.copy}</p>
      <form className="onboarding-form" onSubmit={submit}>
        <label><span>文字模型服务</span><select name="provider" onChange={(event) => setProvider(event.currentTarget.value)} value={provider}>{model.providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>API Key</span><input autoComplete="new-password" maxLength={1000} name="apiKey" onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={model.ready ? "已保存；重新填写才会替换" : "填写所选服务的 API Key"} required={!model.ready} type="password" value={apiKey} /></label>
        <p className="onboarding-hint">需要自定义服务地址或模型映射时，之后可以在“管理 → Claude Code”中调整。</p>
        <OnboardingError error={snapshot.error} />
        <div className="onboarding-actions"><button className="secondary-button" disabled={!model.ready} onClick={() => actions.continue("multimodal")} type="button">沿用当前配置</button><button className="primary-button">保存并继续</button></div>
      </form>
    </section>
  );
}

function MultimodalStep({ snapshot, actions }) {
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">2 / 4 · OPTIONAL</span>
      <h2>图片、声音和视频按需再配</h2>
      <p>纯文字聊天现在已经够用，不需要额外 API。以后要使用这些功能时，再为它们选择对应的 API 即可。</p>
      <div className="onboarding-capability-list"><article><strong>图片</strong><span>生图、图片理解</span></article><article><strong>声音</strong><span>音色设计、语音消息</span></article><article><strong>视频</strong><span>视频理解</span></article></div>
      <p className="onboarding-hint">在“管理 → API”先添加 API，再在功能列表中指定给图片、声音或视频。</p>
      <OnboardingError error={snapshot.error} />
      <div className="onboarding-actions"><button className="secondary-button" onClick={actions.openApiServices} type="button">现在配置多模态 API</button><button className="primary-button" onClick={() => actions.continue("projects")} type="button">继续下一步</button></div>
    </section>
  );
}

function ProjectsStep({ snapshot, actions }) {
  const root = snapshot.contactsRoot;
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">3 / 4 · CONTACTS</span>
      <h2>选择 Agent 工作目录</h2>
      <p>每个联系人都会在这里拥有独立的 Claude 项目、提示词和能力开关。</p>
      <div className={`onboarding-path${root ? " ready" : ""}`}><span>Agent 工作目录</span><strong>{root || "还没有选择"}</strong></div>
      <OnboardingError error={snapshot.error} />
      <div className="onboarding-actions"><button className="secondary-button" onClick={() => { void actions.selectContactsRoot(); }} type="button">选择目录</button><button className="primary-button" disabled={!root} onClick={() => actions.continue("contact")} type="button">继续</button></div>
    </section>
  );
}

function ContactStep({ snapshot, actions }) {
  const [name, setName] = useState("");
  if (snapshot.hasContact) {
    return (
      <section className="onboarding-body">
        <span className="reference-kicker">4 / 4 · CONTACT</span>
        <h2>第一个联系人已经准备好</h2>
        <p>现在可以进入对话页，和这个联系人开始聊天。</p>
        <OnboardingError error={snapshot.error} />
        <div className="onboarding-actions"><button className="primary-button" onClick={() => { void actions.complete(); }} type="button">进入对话</button></div>
      </section>
    );
  }
  return (
    <section className="onboarding-body">
      <span className="reference-kicker">4 / 4 · CONTACT</span>
      <h2>创建第一个联系人</h2>
      <p>给联系人写一个备注即可。Suzu 会创建独立项目，并把它设为当前联系人。</p>
      <form className="onboarding-form" onSubmit={(event) => { event.preventDefault(); void actions.createContact(name); }}>
        <label><span>联系人备注</span><input autoComplete="off" maxLength={80} onChange={(event) => setName(event.currentTarget.value)} placeholder="例如：Suzu" required value={name} /></label>
        <OnboardingError error={snapshot.error} />
        <div className="onboarding-actions"><button className="primary-button">创建并进入对话</button></div>
      </form>
    </section>
  );
}

function StepBody({ snapshot, actions }) {
  if (snapshot.step === "multimodal") return <MultimodalStep actions={actions} snapshot={snapshot} />;
  if (snapshot.step === "projects") return <ProjectsStep actions={actions} snapshot={snapshot} />;
  if (snapshot.step === "contact") return <ContactStep actions={actions} snapshot={snapshot} />;
  return <TextModelStep actions={actions} snapshot={snapshot} />;
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
