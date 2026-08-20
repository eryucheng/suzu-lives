function clean(value) {
  return String(value ?? "").trim();
}

/**
 * The selected execution source still reads a small group of historical
 * environment keys. Suzu never exposes those keys to product callers: the
 * owned child translates its product-owned launch settings immediately before
 * the kernel boots.
 */
export function applySuzuUpstreamCompatibilityEnvironment(environment = process.env) {
  const target = environment && typeof environment === "object" ? environment : process.env;
  const copy = (legacy, product) => {
    if (clean(target[legacy]) || !clean(target[product])) return;
    target[legacy] = target[product];
  };
  copy("DSH_HOME", "SUZU_AGENT_HOME");
  copy("DSH_AGENTS_HOME", "SUZU_AGENT_AGENTS_HOME");
  copy("DSH_PERMISSION_MODE", "SUZU_AGENT_PERMISSION_MODE");
  copy("DSH_TELEMETRY_DISABLED", "SUZU_AGENT_TELEMETRY_DISABLED");
  return Object.freeze({
    home: clean(target.DSH_HOME),
    agentsHome: clean(target.DSH_AGENTS_HOME),
    permissionMode: clean(target.DSH_PERMISSION_MODE),
  });
}
