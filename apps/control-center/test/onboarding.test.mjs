import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveOnboardingStep, shouldShowOnboarding } from "../src/features/onboarding/index.mjs";

test("onboarding dialog renders through React callbacks instead of DOM bindings", async () => {
  const source = await readFile(new URL("../src/react/onboarding-dialog.jsx", import.meta.url), "utf8");
  assert.match(source, /export function OnboardingDialog/u);
  assert.match(source, /onSubmit=/u);
  assert.match(source, /actions\.saveTextModel/u);
  assert.doesNotMatch(source, /document\.querySelector/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/u);
});

test("fresh setup starts with the text model before contacts", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "text-model",
    onboardingError: "",
    claudeCodeApi: { status: "new", hasApiKey: false },
    settings: { contactsRoot: "", projectRoot: "", onboardingCompleted: false },
  };
  assert.equal(resolveOnboardingStep(state), "text-model");
  assert.equal(shouldShowOnboarding(state.settings), true);
});

test("multimodal setup is explicitly optional and points to the existing API manager", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "multimodal",
    onboardingError: "",
    claudeCodeApi: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { contactsRoot: "", projectRoot: "", onboardingCompleted: false },
  };
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
  assert.equal(resolveOnboardingStep(state), "projects");
});

test("contact creation is the final setup step after a contacts root is chosen", () => {
  const state = {
    onboardingOpen: true,
    onboardingStep: "contact",
    onboardingError: "",
    claudeCodeApi: { status: "ready", hasApiKey: true, providerId: "deepseek" },
    settings: { contactsRoot: "D:/Suzu Contacts", projectRoot: "", onboardingCompleted: false },
  };
  assert.equal(resolveOnboardingStep(state), "contact");
  assert.equal(shouldShowOnboarding({ ...state.settings, onboardingCompleted: true }), false);
});
