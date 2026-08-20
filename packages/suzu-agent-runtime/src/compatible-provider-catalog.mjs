/**
 * Suzu intentionally has no baked-in third-party provider catalogue.
 *
 * Every non-native text endpoint is explicitly configured by the user in the
 * Suzu model settings.  The selected upstream adapter imports this tiny
 * product-owned facade instead of pi-ai's "all providers" catalogue, which
 * would otherwise pull SDKs and model data for providers Suzu never enables.
 */
export function builtinProviders() {
  return [];
}

export function getBuiltinModels() {
  return [];
}

export function getBuiltinProviders() {
  return [];
}
