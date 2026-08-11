function clean(value) {
  return String(value ?? "").trim();
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
