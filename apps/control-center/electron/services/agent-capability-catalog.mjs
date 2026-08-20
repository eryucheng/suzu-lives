import { createCapabilityRegistry } from "./capability-registry.mjs";

// Kept as a small compatibility-facing reader for existing renderer code.
// The data itself now lives with config/resource/lifecycle declarations in the
// capability registry, rather than being copied into a second static list.
const registry = createCapabilityRegistry();

export function agentCapabilityCatalog() {
  return registry.catalog().map((capability) => ({
    ...capability,
    ...(capability.setting ? { setting: { ...capability.setting } } : {}),
  }));
}
