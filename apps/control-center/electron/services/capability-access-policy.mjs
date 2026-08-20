import fs from "node:fs";
import path from "node:path";

const CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value
    : {};
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataRootFor(settingsService) {
  const settings = settingsService?.load?.() || {};
  const response = typeof settingsService?.response === "function"
    ? settingsService.response(settings)
    : settings;
  const dataRoot = clean(response?.dataRoot);
  return dataRoot && path.isAbsolute(dataRoot) ? path.resolve(dataRoot) : "";
}

function enabledContactIds(value) {
  const source = plainObject(value);
  const values = Array.isArray(source.enabledContactIds) ? source.enabledContactIds : [];
  return new Set(values.map(clean).filter((id) => CONTACT_ID.test(id)));
}

/**
 * Resolves the per-contact installation state. Agent Core uses one generic
 * bridge instead, so the same decision must happen before an action is shown
 * or invoked.  The policy reads only product-owned capability config files;
 * it neither changes a contact project nor grants a new tool.
 */
export function createCapabilityAccessPolicy({ capabilityRegistry, settingsService, fsOps = fs } = {}) {
  if (!capabilityRegistry || typeof capabilityRegistry.get !== "function" || typeof capabilityRegistry.configPath !== "function") {
    throw new Error("能力访问策略需要能力注册表。 ");
  }
  if (!settingsService || typeof settingsService.load !== "function") {
    throw new Error("能力访问策略需要软件设置服务。 ");
  }
  if (typeof fsOps?.lstatSync !== "function" || typeof fsOps?.readFileSync !== "function") {
    throw new Error("能力访问策略需要同步文件读取接口。 ");
  }

  const configFor = (capabilityId) => {
    const root = dataRootFor(settingsService);
    const segments = capabilityRegistry.configPath(clean(capabilityId));
    if (!root || !Array.isArray(segments) || !segments.length) return {};
    const target = path.resolve(root, ...segments);
    if (!inside(root, target)) return {};
    try {
      const stat = fsOps.lstatSync(target);
      if (stat.isSymbolicLink?.() || !stat.isFile?.()) return {};
      return plainObject(JSON.parse(fsOps.readFileSync(target, "utf8")));
    } catch {
      return {};
    }
  };

  const isEnabledForContact = ({ capabilityId, contactId } = {}) => {
    const capability = capabilityRegistry.get(clean(capabilityId));
    if (!capability) return false;
    if (capability.config?.contactScoped !== true) return true;
    const id = clean(contactId);
    if (!CONTACT_ID.test(id)) return false;
    return enabledContactIds(configFor(capability.id)).has(id);
  };

  const canInvoke = ({ capability, context } = {}) => {
    const id = clean(capability?.id);
    if (!id) return false;
    return isEnabledForContact({ capabilityId: id, contactId: plainObject(context).contactId });
  };

  return Object.freeze({
    canInvoke,
    isEnabledForContact,
  });
}
