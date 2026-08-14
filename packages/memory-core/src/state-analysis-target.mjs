const SIMPLE_TARGET_FAMILIES = new Set([
  "preference",
  "habit",
  "disposition",
  "value",
  "goal",
  "capability",
  "self_concept",
  "condition",
]);
const IDENTITY_FIELDS = new Set([
  "name", "alias", "birth_date", "birth_year", "age", "gender", "pronouns",
  "occupation", "employer", "education", "residence", "hometown", "nationality",
  "biography", "other",
]);
const IDENTITY_CARDINALITIES = new Set(["single", "multi_item", "sequence"]);
const OBJECT_ROLES = new Set(["user", "agent", "other", "world"]);
const PERSONAL_ROLES = new Set(["user", "agent", "other"]);

function clean(value) {
  return String(value ?? "").trim();
}

function sourceObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function invalid(stateFamily) {
  throw new Error(`State analysis targetSpec is invalid for ${stateFamily || "(empty)"}.`);
}

export function normalizeStateAnalysisTargetSpec(stateFamily, value, { allowEmpty = true } = {}) {
  const family = clean(stateFamily);
  if (value !== undefined && value !== null
    && (typeof value !== "object" || Array.isArray(value))) {
    return invalid(family);
  }
  const source = sourceObject(value);
  if (Object.keys(source).length === 0) {
    if (allowEmpty || SIMPLE_TARGET_FAMILIES.has(family)) return {};
    return invalid(family);
  }
  if (SIMPLE_TARGET_FAMILIES.has(family)) return invalid(family);
  if (family === "identity") {
    if (!exactKeys(source, ["identityField", "fieldCardinality"])) return invalid(family);
    const identityField = clean(source.identityField);
    const fieldCardinality = clean(source.fieldCardinality);
    if (!IDENTITY_FIELDS.has(identityField) || !IDENTITY_CARDINALITIES.has(fieldCardinality)) {
      return invalid(family);
    }
    return { identityField, fieldCardinality };
  }
  if (family === "belief") {
    if (!exactKeys(source, ["objectRole", "objectKey", "objectLabel"])) return invalid(family);
    const objectRole = clean(source.objectRole);
    const objectKey = clean(source.objectKey);
    const objectLabel = clean(source.objectLabel);
    if (!OBJECT_ROLES.has(objectRole) || !objectLabel || (objectRole !== "world" && !objectKey)) {
      return invalid(family);
    }
    if (objectRole === "world" && objectKey) return invalid(family);
    return { objectRole, objectKey, objectLabel };
  }
  if (family === "relationship") {
    if (!exactKeys(source, [
      "counterpartRole", "counterpartKey", "counterpartLabel", "direction",
    ])) return invalid(family);
    const counterpartRole = clean(source.counterpartRole);
    const counterpartKey = clean(source.counterpartKey);
    const counterpartLabel = clean(source.counterpartLabel);
    const direction = clean(source.direction);
    if (!PERSONAL_ROLES.has(counterpartRole) || !counterpartKey || !counterpartLabel
      || direction !== "holder_to_counterpart") return invalid(family);
    return { counterpartRole, counterpartKey, counterpartLabel, direction };
  }
  if (family === "affective_association") {
    if (!exactKeys(source, ["triggerRole", "triggerKey", "triggerLabel"])) return invalid(family);
    const triggerRole = clean(source.triggerRole);
    const triggerKey = clean(source.triggerKey);
    const triggerLabel = clean(source.triggerLabel);
    if (!PERSONAL_ROLES.has(triggerRole) || !triggerKey || !triggerLabel) return invalid(family);
    return { triggerRole, triggerKey, triggerLabel };
  }
  return invalid(family);
}

export function isStateAnalysisTargetComplete(stateFamily, value) {
  const family = clean(stateFamily);
  if (SIMPLE_TARGET_FAMILIES.has(family)) return true;
  try {
    return Object.keys(normalizeStateAnalysisTargetSpec(family, value, { allowEmpty: false })).length > 0;
  } catch {
    return false;
  }
}
