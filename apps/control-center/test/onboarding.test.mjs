import assert from "node:assert/strict";
import test from "node:test";

import { renderOnboarding, resolveOnboardingStep, shouldShowOnboarding } from "../src/features/onboarding/index.mjs";

function context(state) {
  return { state };
}

test("fresh setup starts with the text model before contacts", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "text-model",
    onboardingError: "",
    claudeCodeApi: { status: "new", hasApiKey: false },
    settings: { contactsRoot: "", projectRoot: "", onboardingCompleted: false },
  };
  const html = renderOnboarding(context(state));
  assert.equal(resolveOnboardingStep(state), "text-model");
  assert.equal(shouldShowOnboarding(state.settings), true);
  assert.match(html, /先让 Claude Code 能聊天/u);
  assert.match(html, /data-onboarding-text-model-form/u);
  assert.match(html, /DeepSeek/u);
  assert.doesNotMatch(html, />自定义</u);
});

test("multimodal setup is explicitly optional and points to the existing API manager", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "multimodal",
    onboardingError: "",
    claudeCodeApi: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { contactsRoot: "", projectRoot: "", onboardingCompleted: false },
  };
  const html = renderOnboarding(context(state));
  assert.match(html, /纯文字聊天现在已经够用/u);
  assert.match(html, /data-onboarding-open-api/u);
  assert.match(html, /继续下一步/u);
  assert.equal(resolveOnboardingStep(state), "multimodal");
});

test("a configured multimodal API advances fresh setup to the contacts directory", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "projects",
    onboardingError: "",
    claudeCodeApi: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { contactsRoot: "", projectRoot: "", onboardingCompleted: false, onboardingMultimodalCompleted: false },
    apiServices: { connections: [{ id: "bailian", type: "dashscope", configured: true }] },
  };
  const html = renderOnboarding(context(state));
  assert.equal(resolveOnboardingStep(state), "projects");
  assert.match(html, /选择 Agent 工作目录/u);
  assert.match(html, /data-onboarding-select-root/u);
});

test("contact creation is the final setup step after a contacts root is chosen", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "contact",
    onboardingError: "",
    claudeCodeApi: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { contactsRoot: "D:/Suzu Contacts", projectRoot: "", onboardingCompleted: false },
  };
  const html = renderOnboarding(context(state));
  assert.match(html, /创建第一个联系人/u);
  assert.match(html, /data-onboarding-contact-form/u);
  assert.equal(resolveOnboardingStep(state), "contact");
  assert.equal(shouldShowOnboarding({ ...state.settings, onboardingCompleted: true }), false);
});
