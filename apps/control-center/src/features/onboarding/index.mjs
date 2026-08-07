import { escapeHtml } from "../../core/formatters.mjs";
import { CLAUDE_CODE_API_PROVIDERS } from "../agent/index.mjs";

const STEPS = Object.freeze([
  ["text-model", "文字模型"],
  ["multimodal", "多模态 API"],
  ["projects", "联系人目录"],
  ["contact", "首个联系人"],
]);

const PREVIOUS_STEP = Object.freeze({
  multimodal: "text-model",
  projects: "multimodal",
  contact: "projects",
});

function clean(value) {
  return String(value ?? "").trim();
}

function configuredProviderId(config) {
  return CLAUDE_CODE_API_PROVIDERS[config?.providerId] ? config.providerId : "deepseek";
}

function providerOptions(activeId) {
  return Object.entries(CLAUDE_CODE_API_PROVIDERS)
    .filter(([id]) => id !== "custom")
    .map(([id, provider]) => `<option value="${escapeHtml(id)}" ${id === activeId ? "selected" : ""}>${escapeHtml(provider.label)}</option>`)
    .join("");
}

function errorCopy(state) {
  return state.onboardingError ? `<p class="onboarding-error" role="alert">${escapeHtml(state.onboardingError)}</p>` : "";
}

function textModelStep({ state }) {
  const config = state.claudeCodeApi || {};
  const ready = config.status === "ready" && config.hasApiKey;
  const providerId = configuredProviderId(config);
  const provider = CLAUDE_CODE_API_PROVIDERS[providerId];
  const activeCopy = ready
    ? `已配置 ${provider.label}。可以直接继续，或重新填写密钥来更新这个服务。`
    : "保存后，Suzu 和这台电脑上新开的 Claude Code 终端会使用同一文字模型服务。";
  return `<section class="onboarding-body">
    <span class="reference-kicker">1 / 4 · TEXT MODEL</span>
    <h2>先让 Claude Code 能聊天</h2>
    <p>${escapeHtml(activeCopy)}</p>
    <form class="onboarding-form" data-onboarding-text-model-form>
      <label><span>文字模型服务</span><select name="provider">${providerOptions(providerId)}</select></label>
      <label><span>API Key</span><input name="apiKey" type="password" autocomplete="new-password" maxlength="1000" placeholder="${ready ? "已保存；重新填写才会替换" : "填写所选服务的 API Key"}" ${ready ? "" : "required"}></label>
      <p class="onboarding-hint">需要自定义服务地址或模型映射时，之后可以在“管理 → Claude Code”中调整。</p>
      ${errorCopy(state)}
      <div class="onboarding-actions"><button type="button" class="secondary-button" data-onboarding-next="multimodal" ${ready ? "" : "disabled"}>沿用当前配置</button><button class="primary-button">保存并继续</button></div>
    </form>
  </section>`;
}

function multimodalStep({ state }) {
  return `<section class="onboarding-body">
    <span class="reference-kicker">2 / 4 · OPTIONAL</span>
    <h2>图片、声音和视频按需再配</h2>
    <p>纯文字聊天现在已经够用，不需要额外 API。以后要使用这些功能时，再为它们选择对应的 API 即可。</p>
    <div class="onboarding-capability-list"><article><strong>图片</strong><span>生图、图片理解</span></article><article><strong>声音</strong><span>音色设计、语音消息</span></article><article><strong>视频</strong><span>视频理解</span></article></div>
    <p class="onboarding-hint">在“管理 → API”先添加 API，再在功能列表中指定给图片、声音或视频。</p>
    ${errorCopy(state)}
    <div class="onboarding-actions"><button type="button" class="secondary-button" data-onboarding-open-api>现在配置多模态 API</button><button type="button" class="primary-button" data-onboarding-next="projects">继续下一步</button></div>
  </section>`;
}

function projectsStep({ state }) {
  const root = clean(state.settings?.contactsRoot);
  return `<section class="onboarding-body">
    <span class="reference-kicker">3 / 4 · CONTACTS</span>
    <h2>选择 Agent 工作目录</h2>
    <p>每个联系人都会在这里拥有独立的 Claude 项目、提示词和能力开关。</p>
    <div class="onboarding-path ${root ? "ready" : ""}"><span>Agent 工作目录</span><strong>${escapeHtml(root || "还没有选择")}</strong></div>
    ${errorCopy(state)}
    <div class="onboarding-actions"><button type="button" class="secondary-button" data-onboarding-select-root>选择目录</button><button type="button" class="primary-button" data-onboarding-next="contact" ${root ? "" : "disabled"}>继续</button></div>
  </section>`;
}

function contactStep({ state }) {
  const hasContact = Boolean(clean(state.settings?.projectRoot));
  if (hasContact) return `<section class="onboarding-body">
    <span class="reference-kicker">4 / 4 · CONTACT</span>
    <h2>第一个联系人已经准备好</h2>
    <p>现在可以进入对话页，和这个联系人开始聊天。</p>
    ${errorCopy(state)}
    <div class="onboarding-actions"><button type="button" class="primary-button" data-onboarding-complete>进入对话</button></div>
  </section>`;
  return `<section class="onboarding-body">
    <span class="reference-kicker">4 / 4 · CONTACT</span>
    <h2>创建第一个联系人</h2>
    <p>给联系人写一个备注即可。Suzu 会创建独立项目，并把它设为当前联系人。</p>
    <form class="onboarding-form" data-onboarding-contact-form>
      <label><span>联系人备注</span><input name="name" maxlength="80" autocomplete="off" placeholder="例如：Suzu" required></label>
      ${errorCopy(state)}
      <div class="onboarding-actions"><button class="primary-button">创建并进入对话</button></div>
    </form>
  </section>`;
}

function bodyForStep(context, step) {
  if (step === "multimodal") return multimodalStep(context);
  if (step === "projects") return projectsStep(context);
  if (step === "contact") return contactStep(context);
  return textModelStep(context);
}

export function resolveOnboardingStep(state) {
  if (!state?.claudeCodeApi?.hasApiKey) return "text-model";
  const hasConfiguredMultimodalApi = Array.isArray(state?.apiServices?.connections)
    && state.apiServices.connections.some((connection) => connection?.configured === true);
  const multimodalCompleted = state?.settings?.onboardingMultimodalCompleted === true || hasConfiguredMultimodalApi;
  if (!clean(state?.settings?.contactsRoot) && !multimodalCompleted) return "multimodal";
  if (!clean(state?.settings?.contactsRoot)) return "projects";
  if (!clean(state?.settings?.projectRoot)) return "contact";
  return "text-model";
}

export function shouldShowOnboarding(settings) {
  return settings?.onboardingCompleted !== true
    && (!clean(settings?.contactsRoot) || !clean(settings?.projectRoot));
}

export function renderOnboarding(context) {
  const { state } = context;
  if (!state.onboardingOpen) return "";
  const step = STEPS.some(([id]) => id === state.onboardingStep) ? state.onboardingStep : resolveOnboardingStep(state);
  const activeIndex = STEPS.findIndex(([id]) => id === step);
  const previous = PREVIOUS_STEP[step];
  return `<div class="onboarding-overlay">
    <section class="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
      <header class="onboarding-header"><div><span class="reference-kicker">SUZU LIVES</span><h1 id="onboardingTitle">开始使用</h1></div><button type="button" class="onboarding-close suzu-close-button" data-close-onboarding aria-label="稍后设置" title="稍后设置">×</button></header>
      <ol class="onboarding-steps" aria-label="首次设置步骤">${STEPS.map(([id, label], index) => `<li class="${index === activeIndex ? "active" : ""}${index < activeIndex ? " complete" : ""}"><span>${index + 1}</span><b>${escapeHtml(label)}</b></li>`).join("")}</ol>
      ${bodyForStep(context, step)}
      <footer class="onboarding-footer">${previous ? `<button type="button" class="text-button" data-onboarding-back="${previous}">返回上一步</button>` : "<span></span>"}<button type="button" class="text-button" data-close-onboarding>稍后设置</button></footer>
    </section>
  </div>`;
}

function setError(context, error) {
  context.state.onboardingError = clean(error?.message || error) || "暂时无法完成这一步。";
  context.render();
}

async function completeOnboarding(context) {
  context.state.settings = await context.api.settings.update({ onboardingCompleted: true });
  context.state.onboardingOpen = false;
  context.state.onboardingError = "";
  context.setView("relationships");
  context.setRelationshipPage("conversation");
}

export function bindOnboardingEvents(context) {
  document.querySelectorAll("[data-close-onboarding]").forEach((button) => button.addEventListener("click", () => {
    context.state.onboardingOpen = false;
    context.state.onboardingError = "";
    context.render();
  }));
  document.querySelectorAll("[data-onboarding-back]").forEach((button) => button.addEventListener("click", () => {
    context.state.onboardingStep = button.dataset.onboardingBack;
    context.state.onboardingError = "";
    context.render();
  }));
  document.querySelectorAll("[data-onboarding-next]").forEach((button) => button.addEventListener("click", async () => {
    if (button.disabled) return;
    if (context.state.onboardingStep === "multimodal" && button.dataset.onboardingNext === "projects") {
      try {
        context.state.settings = await context.api.settings.update({ onboardingMultimodalCompleted: true });
      } catch (error) {
        setError(context, error);
        return;
      }
    }
    context.state.onboardingStep = button.dataset.onboardingNext;
    context.state.onboardingError = "";
    context.render();
  }));
  document.querySelector("[data-onboarding-text-model-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      context.state.claudeCodeApi = await context.api.agentRuntime.saveClaudeCodeApi({
        provider: form.get("provider"),
        apiKey: form.get("apiKey"),
        authMode: "auth-token",
        skipOnboarding: true,
      });
      if (context.state.claudeCodeApi?.status !== "ready") throw new Error("文字模型还没有可用的 API Key。请填写后再保存。");
      context.state.onboardingStep = "multimodal";
      context.state.onboardingError = "";
      context.render();
    } catch (error) {
      setError(context, error);
    }
  });
  document.querySelector("[data-onboarding-open-api]")?.addEventListener("click", () => {
    context.state.onboardingOpen = false;
    context.state.onboardingStep = "multimodal";
    context.state.onboardingError = "";
    context.setAdminTab("api-services");
    context.setView("admin");
  });
  document.querySelector("[data-onboarding-select-root]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await context.api.settings.selectProject();
      if (result?.canceled || !result?.settings) {
        context.render();
        return;
      }
      context.state.settings = { ...context.state.settings, ...result.settings };
      context.state.onboardingStep = "contact";
      context.state.onboardingError = "";
      context.render();
    } catch (error) {
      setError(context, error);
    }
  });
  document.querySelector("[data-onboarding-contact-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = clean(form.get("name"));
    if (!name) return;
    const submit = event.currentTarget.querySelector("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      await context.api.conversation.createContact({ name });
      context.state.settings = await context.api.settings.get();
      await completeOnboarding(context);
    } catch (error) {
      setError(context, error);
    }
  });
  document.querySelector("[data-onboarding-complete]")?.addEventListener("click", async () => {
    try {
      await completeOnboarding(context);
    } catch (error) {
      setError(context, error);
    }
  });
}
