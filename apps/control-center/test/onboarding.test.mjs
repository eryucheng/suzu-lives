import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { hasPersonaContent, mainModelIsReady, resolveOnboardingStep, shouldShowOnboarding } from "../src/features/onboarding/index.mjs";

test("onboarding dialog renders through React callbacks instead of DOM bindings", async () => {
  const source = await readFile(new URL("../src/react/onboarding-dialog.jsx", import.meta.url), "utf8");
  assert.match(source, /export function OnboardingDialog/u);
  assert.match(source, /onSubmit=/u);
  assert.match(source, /actions\.saveMainModel/u);
  assert.match(source, /服务地址/u);
  assert.match(source, /接口协议/u);
  assert.match(source, /主模型/u);
  assert.match(source, /actions\.openContactCreate/u);
  assert.match(source, /actions\.openPersonaSetup/u);
  assert.doesNotMatch(source, /document\.querySelector/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(source, /多模态 API/u);
  assert.doesNotMatch(source, /actions\.createContact/u);
});

test("application mounts the first-run guide with its overlay stylesheet and derives its visible step from saved setup", async () => {
  const [appSource, shellSource, stylesSource] = await Promise.all([
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/react/app-shell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(shellSource, /OnboardingDialog/u);
  assert.match(stylesSource, /@import\s+["']\.\/styles\/onboarding\.css["']/u);
  assert.match(appSource, /onboarding:\s*onboardingWorkspace\(\)/u);
  assert.match(appSource, /prepareOnboarding\(\{ open: true, allowCompleted: true \}\)/u);
  assert.match(appSource, /shouldShowOnboarding\(state\.settings\)/u);
  assert.match(appSource, /onContactCreated:\s*advanceOnboardingAfterContact/u);
  assert.match(appSource, /state\.onboardingStep = "ready"/u);
});

test("fresh setup starts with the main model", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "main-model",
    onboardingPersonaReady: false,
    onboardingError: "",
    agentRuntime: { status: "new", hasApiKey: false },
    settings: { projectRoot: "", onboardingCompleted: false },
  };
  assert.equal(mainModelIsReady(state.agentRuntime), false);
  assert.equal(resolveOnboardingStep(state), "main-model");
  assert.equal(shouldShowOnboarding(state.settings), true);
});

test("a configured main model advances to creating a contact", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "contact",
    onboardingPersonaReady: false,
    onboardingError: "",
    agentRuntime: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { projectRoot: "", onboardingCompleted: false },
  };
  assert.equal(mainModelIsReady(state.agentRuntime), true);
  assert.equal(resolveOnboardingStep(state), "contact");
});

test("a contact without persona advances to persona, then to ready after save", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "persona",
    onboardingPersonaReady: false,
    onboardingError: "",
    agentRuntime: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { projectRoot: "D:/Suzu Contacts/Suzu", onboardingCompleted: false },
  };
  assert.equal(resolveOnboardingStep(state), "persona");
  assert.equal(hasPersonaContent({ files: [{ path: "persona.md", content: "我是五十铃。" }] }), true);
  assert.equal(hasPersonaContent({ files: [{ path: "persona.md", content: "   " }] }), false);
  state.onboardingPersonaReady = true;
  assert.equal(resolveOnboardingStep(state), "ready");
  assert.equal(shouldShowOnboarding({ ...state.settings, onboardingCompleted: true }), false);
});
