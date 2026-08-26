import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PATCH_MARKER = Symbol.for("suzu-lives.compatible-system-messages.v1");
const PATCHED_MODEL_REGISTRIES = new WeakSet();
const TAG_SECRET = randomBytes(32);
const TAG_OPEN = "[[suzu-system-message:";
const TAG_MIDDLE = "]]";
const TAG_CLOSE = "[[/suzu-system-message:";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textContent(message) {
  return (Array.isArray(plainObject(message).content) ? message.content : [])
    .filter((block) => plainObject(block).type === "text")
    .map((block) => String(plainObject(block).text ?? ""))
    .join("\n");
}

function tagSignature(id, text) {
  return createHmac("sha256", TAG_SECRET)
    .update(id)
    .update("\0")
    .update(text)
    .digest("base64url");
}

function encodedSystemText(message) {
  const id = String(plainObject(message).id ?? "");
  const text = textContent(message);
  if (!id || !text) throw new TypeError("compatible system messages require identity and text content.");
  const identity = `${id}.${tagSignature(id, text)}`;
  return `${TAG_OPEN}${identity}${TAG_MIDDLE}${text}${TAG_CLOSE}${identity}${TAG_MIDDLE}`;
}

function decodedSystemText(value) {
  const source = String(value ?? "");
  if (!source.startsWith(TAG_OPEN)) return null;
  const identityEnd = source.indexOf(TAG_MIDDLE, TAG_OPEN.length);
  if (identityEnd < 0) return null;
  const identity = source.slice(TAG_OPEN.length, identityEnd);
  const separator = identity.lastIndexOf(".");
  if (separator <= 0) return null;
  const id = identity.slice(0, separator);
  const signature = identity.slice(separator + 1);
  const close = `${TAG_CLOSE}${identity}${TAG_MIDDLE}`;
  if (!signature || !source.endsWith(close)) return null;
  const text = source.slice(identityEnd + TAG_MIDDLE.length, -close.length);
  const actual = Buffer.from(signature, "base64url");
  const expected = Buffer.from(tagSignature(id, text), "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return text;
}

function decodedWireContent(content) {
  if (typeof content === "string") {
    const text = decodedSystemText(content);
    return text === null ? null : { content: text, text };
  }
  if (!Array.isArray(content)) return null;
  for (let index = 0; index < content.length; index += 1) {
    const part = plainObject(content[index]);
    if (typeof part.text !== "string") continue;
    const text = decodedSystemText(part.text);
    if (text === null) continue;
    const next = [...content];
    next[index] = { ...part, text };
    return { content: next, text };
  }
  return null;
}

function wireInstructionRole(model, { responses = false } = {}) {
  const source = plainObject(model);
  const compat = plainObject(source.compat);
  if (source.reasoning && (responses ? compat.supportsDeveloperRole !== false : compat.supportsDeveloperRole === true)) {
    return "developer";
  }
  return "system";
}

function rewriteMessageList(messages, role) {
  let changed = false;
  const output = (Array.isArray(messages) ? messages : []).map((message) => {
    const source = plainObject(message);
    const decoded = decodedWireContent(source.content);
    if (!decoded) return message;
    changed = true;
    return { ...source, role, content: decoded.content };
  });
  return changed ? output : messages;
}

function appendSystemText(system, text) {
  const blocks = Array.isArray(system)
    ? [...system]
    : typeof system === "string" && system.length
      ? [{ type: "text", text: system }]
      : [];
  blocks.push({ type: "text", text });
  return blocks;
}

function promoteTaggedMessagesToSystem(payload) {
  let system = payload.system;
  let changed = false;
  const messages = [];
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    const source = plainObject(message);
    const decoded = decodedWireContent(source.content);
    if (!decoded) {
      messages.push(message);
      continue;
    }
    changed = true;
    system = appendSystemText(system, decoded.text);
  }
  return changed ? { ...payload, messages, system } : payload;
}

export function tagCompatibleSystemMessages(request) {
  const source = plainObject(request);
  let changed = false;
  const messages = (Array.isArray(source.messages) ? source.messages : []).map((message) => {
    if (plainObject(message).role !== "system") return message;
    changed = true;
    return {
      ...message,
      content: [{ type: "text", text: encodedSystemText(message) }],
    };
  });
  return changed ? { ...source, messages } : request;
}

export function rewriteCompatibleSystemMessagePayload(payload, model) {
  const source = plainObject(payload);
  switch (String(plainObject(model).api ?? "")) {
    case "openai-completions": {
      const messages = rewriteMessageList(source.messages, wireInstructionRole(model));
      return messages === source.messages ? payload : { ...source, messages };
    }
    case "openai-responses": {
      const input = rewriteMessageList(source.input, wireInstructionRole(model, { responses: true }));
      return input === source.input ? payload : { ...source, input };
    }
    case "anthropic-messages":
      return promoteTaggedMessagesToSystem(source);
    default:
      return payload;
  }
}

function patchModelRegistry(models) {
  if (!models || PATCHED_MODEL_REGISTRIES.has(models) || typeof models.streamSimple !== "function") return;
  const upstream = models.streamSimple;
  Object.defineProperty(models, "streamSimple", {
    configurable: true,
    writable: true,
    value(model, context, options = {}) {
      const upstreamPayload = options.onPayload;
      return upstream.call(this, model, context, {
        ...options,
        async onPayload(payload, wireModel) {
          const rewritten = rewriteCompatibleSystemMessagePayload(payload, wireModel || model);
          if (typeof upstreamPayload !== "function") return rewritten;
          return await upstreamPayload(rewritten, wireModel) ?? rewritten;
        },
      });
    },
  });
  PATCHED_MODEL_REGISTRIES.add(models);
}

export function installCompatibleSystemMessageSupport(Adapter) {
  const prototype = Adapter?.prototype;
  if (!prototype || prototype[PATCH_MARKER]) return;
  const upstreamCurrent = prototype.current;
  const upstreamStream = prototype.stream;
  if (typeof upstreamCurrent !== "function" || typeof upstreamStream !== "function") {
    throw new TypeError("compatible system message support requires current() and stream().");
  }
  Object.defineProperty(prototype, PATCH_MARKER, { value: true });
  Object.defineProperty(prototype, "current", {
    configurable: true,
    writable: true,
    value(...args) {
      const current = upstreamCurrent.apply(this, args);
      patchModelRegistry(current?.models);
      return current;
    },
  });
  Object.defineProperty(prototype, "stream", {
    configurable: true,
    writable: true,
    async *value(request) {
      yield* upstreamStream.call(this, tagCompatibleSystemMessages(request));
    },
  });
}
