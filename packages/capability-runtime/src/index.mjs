import { createHash, createHmac, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class CapabilityExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CapabilityExecutionError";
    this.code = code;
    this.details = details;
  }
}

const AUTHORIZATION_VERSION = 1;
const AUTHORIZATION_PREFIX = "suzu-capability-v1";
const DEFAULT_AUTHORIZATION_TTL_MS = 60_000;
const MAX_AUTHORIZATION_TTL_MS = 5 * 60_000;
const verifiedAuthorizations = new WeakMap();

function clean(value) {
  return String(value ?? "").trim();
}

function unavailableDependencies(value) {
  if (Array.isArray(value)) return value.filter((item) => clean(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([, available]) => available !== true)
    .map(([name]) => name);
}

function requiredDataRoot(value) {
  const root = clean(value);
  if (!root) throw new CapabilityExecutionError("AUTHORIZATION_DATA_ROOT_REQUIRED", "缺少 Suzu Lives 软件数据目录，无法验证调用授权。 ");
  return path.resolve(root);
}

function authorizationComponent(value, label) {
  const component = clean(value).toLowerCase();
  if (!/^[a-z][a-z0-9:-]{0,127}$/u.test(component)) {
    throw new CapabilityExecutionError("AUTHORIZATION_INTENT_INVALID", `${label}格式无效。`);
  }
  return component;
}

function canonicalValue(value, depth = 0) {
  if (depth > 16) throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域层级过深。 ");
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > 8_192) throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域文本过长。 ");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域包含无效数字。 ");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域数组过长。 ");
    return value.map((item) => canonicalValue(item, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域必须是普通 JSON 值。 ");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域字段过多。 ");
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(key)) {
      throw new CapabilityExecutionError("AUTHORIZATION_SCOPE_INVALID", "授权作用域字段名无效。 ");
    }
    return [key, canonicalValue(item, depth + 1)];
  }));
}

export function capabilityScopeDigest(scope = {}) {
  const canonical = JSON.stringify(canonicalValue(scope));
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

function nowMilliseconds(now) {
  const value = typeof now === "function" ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new CapabilityExecutionError("AUTHORIZATION_CLOCK_INVALID", "授权时钟无效。 ");
  return Math.floor(milliseconds);
}

function ttlMilliseconds(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTHORIZATION_TTL_MS;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_AUTHORIZATION_TTL_MS) {
    throw new CapabilityExecutionError("AUTHORIZATION_TTL_INVALID", `授权有效期必须是 1 到 ${MAX_AUTHORIZATION_TTL_MS} 毫秒。`);
  }
  return ttl;
}

function authorizationRoot(root) {
  return path.join(requiredDataRoot(root), "capabilities", "authorization");
}

function signingKeyPath(root) {
  return path.join(authorizationRoot(root), "signing.key");
}

function decodeSigningKey(value) {
  const text = clean(value);
  if (!/^[A-Za-z0-9_-]{32,}$/u.test(text)) return null;
  const key = Buffer.from(text, "base64url");
  return key.length >= 32 ? key : null;
}

function readOrCreateSigningKey(root, { fsOps = fs, randomBytes = systemRandomBytes } = {}) {
  const destination = signingKeyPath(root);
  try {
    const existing = decodeSigningKey(fsOps.readFileSync(destination, "utf8"));
    if (!existing) throw new CapabilityExecutionError("AUTHORIZATION_SIGNING_KEY_INVALID", "软件调用授权密钥无效，已拒绝调用。 ");
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    fsOps.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const key = Buffer.from(randomBytes(32));
    if (key.length < 32) throw new CapabilityExecutionError("AUTHORIZATION_SIGNING_KEY_INVALID", "软件未生成足够强度的调用授权密钥。 ");
    fsOps.writeFileSync(destination, `${key.toString("base64url")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { fsOps.chmodSync?.(destination, 0o600); } catch { /* Windows may not expose POSIX permissions. */ }
    return key;
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = decodeSigningKey(fsOps.readFileSync(destination, "utf8"));
      if (existing) return existing;
    }
    if (error instanceof CapabilityExecutionError) throw error;
    throw new CapabilityExecutionError("AUTHORIZATION_SIGNING_KEY_UNAVAILABLE", "无法准备软件调用授权密钥，已拒绝调用。 ");
  }
}

function signedPayload(payload, key) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(encoded, "utf8").digest("base64url");
  return `${AUTHORIZATION_PREFIX}.${encoded}.${signature}`;
}

function parseCredential(value) {
  const credential = clean(value);
  const [prefix, encoded, signature, extra] = credential.split(".");
  if (!credential || prefix !== AUTHORIZATION_PREFIX || !encoded || !signature || extra) {
    throw new CapabilityExecutionError("AUTHORIZATION_CREDENTIAL_REQUIRED", "实际调用需要由 Suzu Lives 签发的一次性授权凭证。 ");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]+$/u.test(signature)) {
    throw new CapabilityExecutionError("AUTHORIZATION_FORGED", "调用授权凭证格式无效，已拒绝调用。 ");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new CapabilityExecutionError("AUTHORIZATION_FORGED", "调用授权凭证无法验证，已拒绝调用。 ");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CapabilityExecutionError("AUTHORIZATION_FORGED", "调用授权凭证内容无效，已拒绝调用。 ");
  }
  return { encoded, signature, payload };
}

function assertValidSignature(encoded, signature, key) {
  const expected = createHmac("sha256", key).update(encoded, "utf8").digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.toString("base64url") !== signature
    || supplied.length !== expected.length
    || !timingSafeEqual(supplied, expected)) {
    throw new CapabilityExecutionError("AUTHORIZATION_FORGED", "调用授权凭证签名无效，已拒绝调用。 ");
  }
}

function assertPayloadIntent(payload, { abilityId, action, scopeDigest, now }) {
  if (payload.version !== AUTHORIZATION_VERSION
    || authorizationComponent(payload.abilityId, "能力 ID") !== abilityId
    || authorizationComponent(payload.action, "授权动作") !== action
    || clean(payload.scopeDigest) !== scopeDigest
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(clean(payload.nonce))) {
    throw new CapabilityExecutionError("AUTHORIZATION_MISMATCH", "调用授权凭证与本次能力、动作或作用域不匹配，已拒绝调用。 ");
  }
  const issuedAt = Number(payload.issuedAt);
  const expiresAt = Number(payload.expiresAt);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_AUTHORIZATION_TTL_MS) {
    throw new CapabilityExecutionError("AUTHORIZATION_FORGED", "调用授权凭证时间范围无效，已拒绝调用。 ");
  }
  if (issuedAt > now + 30_000) throw new CapabilityExecutionError("AUTHORIZATION_FORGED", "调用授权凭证签发时间无效，已拒绝调用。 ");
  if (expiresAt <= now) throw new CapabilityExecutionError("AUTHORIZATION_EXPIRED", "调用授权凭证已过期，已拒绝调用。 ");
  return { issuedAt, expiresAt };
}

function consumeNonce(root, payload, { fsOps = fs, now } = {}) {
  const destination = path.join(authorizationRoot(root), "used", `${payload.nonce}.json`);
  try {
    fsOps.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fsOps.writeFileSync(destination, `${JSON.stringify({ abilityId: payload.abilityId, action: payload.action, scopeDigest: payload.scopeDigest, expiresAt: payload.expiresAt, usedAt: new Date(now).toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CapabilityExecutionError("AUTHORIZATION_REPLAYED", "调用授权凭证已被使用，不能重放。 ");
    }
    throw new CapabilityExecutionError("AUTHORIZATION_STATE_UNAVAILABLE", "无法记录一次性调用授权状态，已拒绝调用。 ");
  }
}

/**
 * Issues a short-lived signed capability credential. This function belongs to
 * the software control plane; the stable CLI deliberately has no issue mode.
 */
export function issueCapabilityAuthorization({ dataRoot, abilityId, action, scope = {}, ttlMs, now = () => Date.now(), fsOps = fs, randomBytes = systemRandomBytes } = {}) {
  const root = requiredDataRoot(dataRoot);
  const id = authorizationComponent(abilityId, "能力 ID");
  const intentAction = authorizationComponent(action, "授权动作");
  const issuedAt = nowMilliseconds(now);
  const expiresAt = issuedAt + ttlMilliseconds(ttlMs);
  const nonce = Buffer.from(randomBytes(18)).toString("base64url");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) throw new CapabilityExecutionError("AUTHORIZATION_SIGNING_KEY_INVALID", "软件未生成有效的一次性授权标识。 ");
  const digest = capabilityScopeDigest(scope);
  const payload = { version: AUTHORIZATION_VERSION, abilityId: id, action: intentAction, scopeDigest: digest, issuedAt, expiresAt, nonce };
  const credential = signedPayload(payload, readOrCreateSigningKey(root, { fsOps, randomBytes }));
  return Object.freeze({ credential, abilityId: id, action: intentAction, scopeDigest: digest, expiresAt: new Date(expiresAt).toISOString() });
}

/**
 * Validates and atomically consumes a credential before an executor receives a
 * private in-memory authorization context. Nothing supplied by a CLI request
 * can manufacture that context.
 */
export function consumeCapabilityAuthorization({ dataRoot, credential, abilityId, action, scope = {}, now = () => Date.now(), fsOps = fs } = {}) {
  const root = requiredDataRoot(dataRoot);
  const id = authorizationComponent(abilityId, "能力 ID");
  const intentAction = authorizationComponent(action, "授权动作");
  const current = nowMilliseconds(now);
  const digest = capabilityScopeDigest(scope);
  const parsed = parseCredential(credential);
  assertValidSignature(parsed.encoded, parsed.signature, readOrCreateSigningKey(root, { fsOps }));
  const times = assertPayloadIntent(parsed.payload, { abilityId: id, action: intentAction, scopeDigest: digest, now: current });
  consumeNonce(root, parsed.payload, { fsOps, now: current });
  const context = Object.freeze({ abilityId: id, action: intentAction, expiresAt: new Date(times.expiresAt).toISOString() });
  verifiedAuthorizations.set(context, { abilityId: id, action: intentAction, scopeDigest: digest, expiresAt: times.expiresAt });
  return context;
}

/** Executors accept only the private context returned by consumeCapabilityAuthorization. */
export function assertVerifiedCapabilityAuthorization({ authorization, abilityId, action, scope = {} } = {}) {
  const id = authorizationComponent(abilityId, "能力 ID");
  const intentAction = authorizationComponent(action, "授权动作");
  const record = authorization && typeof authorization === "object" ? verifiedAuthorizations.get(authorization) : null;
  if (!record) throw new CapabilityExecutionError("AUTHORIZATION_CREDENTIAL_REQUIRED", "实际调用需要由 Suzu Lives 验证的一次性授权凭证。 ");
  if (record.abilityId !== id || record.action !== intentAction || record.scopeDigest !== capabilityScopeDigest(scope)) {
    throw new CapabilityExecutionError("AUTHORIZATION_MISMATCH", "调用授权凭证与本次能力、动作或作用域不匹配，已拒绝调用。 ");
  }
  return true;
}

/**
 * Every executor calls this before reading an input, creating a runtime
 * directory, starting a process, or making a network request. The registry
 * supplies the persisted enable/configuration state; the executor supplies
 * its concrete dependency checks for this invocation.
 */
export function assertInvocationGate({ abilityId, gate, dependencies = {} } = {}) {
  const id = clean(abilityId) || "unknown";
  if (!gate || typeof gate !== "object") {
    throw new CapabilityExecutionError("CAPABILITY_GATE_REQUIRED", `${id} 缺少软件能力调用门禁。`);
  }
  if (gate.enabled !== true) {
    throw new CapabilityExecutionError("CAPABILITY_DISABLED", `${id} 未启用，已拒绝调用。`, { abilityId: id });
  }
  if (gate.configured !== true) {
    throw new CapabilityExecutionError("CAPABILITY_NOT_CONFIGURED", `${id} 尚未完成 Suzu Lives 配置，已拒绝调用。`, { abilityId: id });
  }
  const missing = unavailableDependencies(dependencies);
  if (missing.length > 0) {
    throw new CapabilityExecutionError(
      "DEPENDENCY_UNAVAILABLE",
      `${id} 缺少可用依赖：${missing.join("、")}。`,
      { abilityId: id, missing },
    );
  }
  return true;
}

export function capabilityFailure(error) {
  if (error instanceof CapabilityExecutionError) {
    return { status: "rejected", code: error.code, message: error.message, ...error.details };
  }
  throw error;
}
