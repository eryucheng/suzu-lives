const DEFAULT_CANDIDATE_LIMIT = 5;
const MAX_CANDIDATE_LIMIT = 10;
const MAX_QUERY_LENGTH = 500;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonical(value) {
  return clean(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, " ");
}

function boundedQuery(value, label) {
  const query = clean(value);
  if (!query) throw new Error(`${label}不能为空。`);
  if (query.length > MAX_QUERY_LENGTH) throw new Error(`${label}不能超过 ${MAX_QUERY_LENGTH} 个字符。`);
  return query;
}

function candidateLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_CANDIDATE_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDIDATE_LIMIT) {
    throw new Error(`候选数量必须是 1 到 ${MAX_CANDIDATE_LIMIT} 的整数。`);
  }
  return limit;
}

function queryTerms(value) {
  const source = canonical(value);
  const terms = new Set(source ? [source] : []);
  const segments = source.match(/[\p{Script=Han}]+|[\p{Letter}\p{Number}_-]+/gu) || [];
  for (const segment of segments) {
    terms.add(segment);
    if (!/^[\p{Script=Han}]+$/u.test(segment) || segment.length < 2) continue;
    const maximum = Math.min(4, segment.length);
    for (let size = 2; size <= maximum; size += 1) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        terms.add(segment.slice(index, index + size));
      }
    }
  }
  return [...terms].filter(Boolean);
}

function fieldScore(fieldValue, term, weight) {
  const field = canonical(fieldValue);
  if (!field || !term) return 0;
  if (field === term) return weight * 4;
  if (field.includes(term)) return weight * 2;
  if (field.length >= 2 && term.includes(field)) return weight;
  return 0;
}

function stickerScore(item, query) {
  const metadata = plainObject(item?.metadata);
  const terms = queryTerms(query);
  let score = 0;
  for (const term of terms) {
    score += fieldScore(metadata.name, term, 12);
    score += fieldScore(metadata.description, term, 4);
    score += fieldScore(item?.fileName, term, 1);
    for (const keyword of Array.isArray(metadata.keywords) ? metadata.keywords : []) {
      score += fieldScore(keyword, term, 10);
    }
  }
  return score;
}

function publicSticker(item) {
  const metadata = plainObject(item?.metadata);
  return Object.freeze({
    builtIn: item?.builtIn === true,
    category: clean(item?.category) || (item?.builtIn === true ? "builtin" : "favorites"),
    categoryName: clean(item?.categoryName) || (item?.builtIn === true ? "内置表情" : "收藏表情"),
    id: clean(item?.id),
    name: clean(metadata.name) || clean(item?.fileName) || "表情",
    description: clean(metadata.description),
    keywords: Object.freeze((Array.isArray(metadata.keywords) ? metadata.keywords : []).map(clean).filter(Boolean)),
  });
}

function matchingStickers(items, query, limit) {
  return Object.freeze((Array.isArray(items) ? items : [])
    .map((item) => ({
      item,
      score: stickerScore(item, query),
      createdAt: Date.parse(clean(item?.createdAt)) || 0,
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt || clean(left.item?.id).localeCompare(clean(right.item?.id), "en"))
    .slice(0, limit)
    .map(({ item }) => publicSticker(item)));
}

function metadataCompleteness(item) {
  const metadata = plainObject(item?.metadata);
  return (clean(metadata.name) ? 20 : 0)
    + (clean(metadata.description) ? 10 : 0)
    + Math.min(10, Array.isArray(metadata.keywords) ? metadata.keywords.map(clean).filter(Boolean).length : 0);
}

function fallbackStickers(items, limit) {
  return Object.freeze((Array.isArray(items) ? items : [])
    .map((item) => ({
      item,
      completeness: metadataCompleteness(item),
      createdAt: Date.parse(clean(item?.createdAt)) || 0,
    }))
    .filter((entry) => entry.completeness > 0)
    .sort((left, right) => right.completeness - left.completeness || right.createdAt - left.createdAt || clean(left.item?.id).localeCompare(clean(right.item?.id), "en"))
    .slice(0, limit)
    .map(({ item }) => publicSticker(item)));
}

export function createEmojiStickerAgentCapabilityAdapter({
  catalog,
  deliver,
} = {}) {
  if (typeof deliver !== "function") throw new Error("表情能力需要聊天交付接口。");
  if (!catalog || typeof catalog.snapshot !== "function" || typeof catalog.asset !== "function") {
    throw new Error("表情能力需要统一表情目录接口。");
  }

  const candidates = async (query, limit, { fallback = false } = {}) => {
    const snapshot = await catalog.snapshot();
    if (clean(snapshot?.status) === "invalid") throw new Error(clean(snapshot?.message) || "表情目录无法读取。");
    const matched = matchingStickers(snapshot?.items, query, limit);
    const items = matched.length || !fallback
      ? matched
      : fallbackStickers(snapshot?.items, limit);
    return Object.freeze({
      status: matched.length ? "matched" : (items.length ? "suggested" : "empty"),
      query,
      items,
    });
  };

  return async ({ action, capability, context, lifecycle } = {}) => {
    if (clean(lifecycle) !== "invoke") {
      return Object.freeze({
        status: "ready",
        capabilityId: clean(capability?.id),
        lifecycle: clean(lifecycle),
        runtime: "emoji-sticker-catalog",
      });
    }
    const actionId = clean(action?.action);
    const request = plainObject(context);
    const input = plainObject(request.input);
    if (actionId === "recommend") {
      const intent = boundedQuery(input.intent || input.query, "表情意图");
      const surrounding = clean(input.context).slice(0, MAX_QUERY_LENGTH);
      return candidates([intent, surrounding].filter(Boolean).join(" "), candidateLimit(input.limit), { fallback: true });
    }
    if (actionId === "search") {
      return candidates(boundedQuery(input.query, "检索词"), candidateLimit(input.limit));
    }
    if (actionId !== "send") throw new Error("表情动作不可用。");

    const id = boundedQuery(input.id, "表情 ID");
    const sticker = await catalog.asset(id);
    const receipt = await deliver({
      input: {
        items: [{
          fileName: sticker.fileName,
          kind: "image",
          path: sticker.path,
        }],
      },
      mediaSource: "sticker",
      projectRoot: clean(request.projectRoot),
      sessionId: clean(request.sessionId),
    });
    return Object.freeze({
      ...plainObject(receipt),
      sticker: publicSticker(sticker),
    });
  };
}

export const emojiStickerAgentCandidateLimits = Object.freeze({
  default: DEFAULT_CANDIDATE_LIMIT,
  maximum: MAX_CANDIDATE_LIMIT,
});
