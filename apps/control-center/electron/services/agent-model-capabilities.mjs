import {
  modelCatalogEntry,
  textModelProviderForRoute,
} from "@suzu-lives/suzu-agent-runtime/model-capability-catalog";

const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = "agent-default-model";
const COMPATIBLE_MODEL_SETTINGS_NAMESPACE = "llm-suzu-compatible";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function supportedInputModalities(value) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : [])
    .map((modality) => clean(modality).toLowerCase())
    .filter((modality) => modality === "text" || modality === "image"))]);
}

function matchingModel(models, model) {
  const id = clean(model).toLowerCase();
  if (!id) return null;
  return (Array.isArray(models) ? models : [])
    .find((entry) => clean(entry?.id).toLowerCase() === id) || null;
}

function configuredModel(settings, provider, model) {
  const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : [];
  const compatible = namespaces.find((entry) => clean(entry?.ns) === COMPATIBLE_MODEL_SETTINGS_NAMESPACE);
  const profiles = plainObject(plainObject(compatible?.value).providers);
  return matchingModel(plainObject(profiles[provider]).models, model);
}

export const EMPTY_AGENT_MODEL_CAPABILITIES = Object.freeze({
  provider: "",
  model: "",
  known: false,
  inputModalities: Object.freeze([]),
  supportsImageInput: false,
});

/**
 * Normalizes the selected model's public input contract into a compact,
 * credential-free runtime snapshot. The snapshot is deliberately derived
 * while the model configuration is read or saved, rather than during a chat
 * turn, so attachment routing never needs to query Agent Core.
 */
export function normalizeAgentModelCapabilities(value = {}) {
  const source = plainObject(value);
  const provider = clean(source.provider);
  const model = clean(source.model);
  const inputModalities = supportedInputModalities(source.inputModalities);
  const known = source.known === true && Boolean(provider && model);
  return Object.freeze({
    provider,
    model,
    known,
    inputModalities,
    supportsImageInput: known && inputModalities.includes("image"),
  });
}

export function selectedAgentModelCapabilities(settings, catalog) {
  const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : [];
  const selectionNamespace = namespaces.find((entry) => clean(entry?.ns) === AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE);
  const selection = plainObject(selectionNamespace?.value);
  const provider = clean(selection.provider);
  const model = clean(selection.model);
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const group = groups.find((entry) => clean(entry?.id) === provider);
  const entry = matchingModel(group?.models, model);
  const profileEntry = configuredModel(settings, provider, model);
  const productEntry = modelCatalogEntry(textModelProviderForRoute(provider), model);
  const catalogInput = supportedInputModalities(entry?.inputModalities || entry?.input);
  const profileInput = supportedInputModalities(profileEntry?.inputModalities || profileEntry?.input);
  const productInput = supportedInputModalities(productEntry?.input);
  return normalizeAgentModelCapabilities({
    provider,
    model,
    known: Boolean(provider && model && (entry || profileEntry || productEntry)),
    inputModalities: productInput.length ? productInput : catalogInput.length ? catalogInput : profileInput,
  });
}
