function clean(value) {
  return String(value ?? "").trim();
}

export function mainModelIsReady(runtime) {
  return runtime?.status === "ready" && runtime?.hasApiKey === true;
}

export function hasPersonaContent(snapshot) {
  return Array.isArray(snapshot?.files) && snapshot.files.some((file) => (
    clean(file?.path).replaceAll("\\", "/").toLowerCase() === "persona.md"
    && Boolean(clean(file?.content))
  ));
}

export function resolveOnboardingStep(state) {
  if (!mainModelIsReady(state?.agentRuntime)) return "main-model";
  if (!clean(state?.settings?.projectRoot)) return "contact";
  if (!state?.onboardingPersonaReady) return "persona";
  return "ready";
}

export function shouldShowOnboarding(settings) {
  return settings?.onboardingCompleted !== true;
}
