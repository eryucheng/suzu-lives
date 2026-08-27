const BANGUMI_API_ORIGIN = "https://api.bgm.tv";
const BANGUMI_IMAGE_ORIGIN = "https://lain.bgm.tv";
const ANILIST_API_URL = "https://graphql.anilist.co";
const ANILIST_IMAGE_ORIGIN = "https://s4.anilist.co";
const REQUEST_TIMEOUT_MS = 8_000;
const SEARCH_RESULT_LIMIT = 20;
const VISIBLE_CANDIDATE_LIMIT = 5;
const MAX_PROFILE_SUMMARY_LENGTH = 2_400;
const MAX_PROFILE_ATTRIBUTE_LENGTH = 240;
const MAX_PROFILE_ATTRIBUTES = 24;
const USER_AGENT = "Suzu-Lives/0.3.2 (https://github.com/Suzu-Lives/Suzu-Lives)";

const ANILIST_CHARACTER_FIELDS = `
  id
  name { full native alternative }
  image { large }
  favourites
  siteUrl
  media(perPage: 10, sort: POPULARITY_DESC) {
    nodes { title { romaji native english } }
  }
`;

const ANILIST_SEARCH_QUERY = `query CharacterAvatarSearch($search: String!) {
  Page(perPage: 10) {
    characters(search: $search, sort: FAVOURITES_DESC) {
      ${ANILIST_CHARACTER_FIELDS}
    }
  }
}`;

const ANILIST_CHARACTER_QUERY = `query CharacterAvatarById($id: Int!) {
  Character(id: $id) {
    ${ANILIST_CHARACTER_FIELDS}
  }
}`;

export class CharacterAvatarProviderError extends Error {
  constructor(message, { cause, code = "CHARACTER_AVATAR_PROVIDER_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CharacterAvatarProviderError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedText(value, maximum) {
  const text = clean(value)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
}

export function normalizedCharacterName(value) {
  return clean(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const key = normalizedCharacterName(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function safeHttpsUrl(value, allowedOrigins) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" && allowedOrigins.has(url.origin) ? url.toString() : "";
  } catch {
    return "";
  }
}

function requestSignal(timeoutMs = REQUEST_TIMEOUT_MS) {
  return typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(timeoutMs)
    : undefined;
}

async function fetchJson(fetchImpl, url, options, sourceLabel) {
  if (typeof fetchImpl !== "function") {
    throw new CharacterAvatarProviderError(`当前没有可用的${sourceLabel}联网接口。`, {
      code: "CHARACTER_AVATAR_FETCH_UNAVAILABLE",
    });
  }
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...plainObject(options?.headers),
      },
      ...(options?.signal ? {} : { signal: requestSignal() }),
    });
  } catch (error) {
    throw new CharacterAvatarProviderError(`无法连接${sourceLabel}。`, {
      cause: error,
      code: "CHARACTER_AVATAR_FETCH_FAILED",
    });
  }
  if (response?.ok !== true) {
    throw new CharacterAvatarProviderError(`${sourceLabel}暂时没有返回可用结果。`, {
      code: "CHARACTER_AVATAR_RESPONSE_INVALID",
    });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new CharacterAvatarProviderError(`${sourceLabel}返回的数据无法读取。`, {
      cause: error,
      code: "CHARACTER_AVATAR_JSON_INVALID",
    });
  }
}

function bangumiInfoboxNames(value) {
  const names = [];
  for (const item of Array.isArray(value) ? value : []) {
    const entry = plainObject(item);
    const key = clean(entry.key);
    if (!/(?:中文名|别名|日文名|英文名|罗马字|昵称)/u.test(key)) continue;
    if (typeof entry.value === "string") {
      names.push(entry.value);
      continue;
    }
    for (const alias of Array.isArray(entry.value) ? entry.value : []) {
      const resolved = plainObject(alias);
      if (clean(resolved.v)) names.push(resolved.v);
    }
  }
  return uniqueStrings(names);
}

function bangumiChineseName(value) {
  for (const item of Array.isArray(value) ? value : []) {
    const entry = plainObject(item);
    if (clean(entry.key) === "简体中文名" && clean(entry.value)) return clean(entry.value);
  }
  return "";
}

function bangumiInfoboxValue(value) {
  if (typeof value === "string") return boundedText(value, MAX_PROFILE_ATTRIBUTE_LENGTH);
  const parts = [];
  for (const item of Array.isArray(value) ? value : []) {
    const entry = plainObject(item);
    const label = clean(entry.k);
    const resolved = clean(entry.v);
    if (resolved) parts.push(label ? `${label}：${resolved}` : resolved);
  }
  return boundedText(parts.join("；"), MAX_PROFILE_ATTRIBUTE_LENGTH);
}

function bangumiProfileAttributes(value) {
  const entry = plainObject(value);
  const attributes = [];
  const seen = new Set();
  const append = (name, rawValue) => {
    const resolvedName = boundedText(name, 60);
    const resolvedValue = boundedText(rawValue, MAX_PROFILE_ATTRIBUTE_LENGTH);
    const key = normalizedCharacterName(resolvedName);
    if (!resolvedName || !resolvedValue || !key || seen.has(key)) return;
    seen.add(key);
    attributes.push({ name: resolvedName, value: resolvedValue });
  };
  for (const item of Array.isArray(entry.infobox) ? entry.infobox : []) {
    const field = plainObject(item);
    const name = clean(field.key);
    if (!name || /(?:引用来源|来源)/u.test(name)) continue;
    append(name, bangumiInfoboxValue(field.value));
    if (attributes.length >= MAX_PROFILE_ATTRIBUTES) break;
  }
  if (clean(entry.gender) && !seen.has(normalizedCharacterName("性别"))) {
    const gender = ({ female: "女", male: "男" })[clean(entry.gender).toLocaleLowerCase()] || entry.gender;
    append("性别", gender);
  }
  return attributes.slice(0, MAX_PROFILE_ATTRIBUTES);
}

function bangumiCandidate(value) {
  const entry = plainObject(value);
  const id = Number(entry.id);
  const name = clean(entry.name);
  if (!Number.isSafeInteger(id) || id <= 0 || !name) return null;
  const aliases = uniqueStrings([name, ...bangumiInfoboxNames(entry.infobox)]);
  const title = bangumiChineseName(entry.infobox) || name;
  const imageUrl = safeHttpsUrl(plainObject(entry.images).large, new Set([BANGUMI_IMAGE_ORIGIN]));
  return {
    provider: "bangumi",
    candidateId: `bangumi:${id}`,
    id,
    name,
    title,
    aliases,
    popularity: Math.max(0, Number(plainObject(entry.stat).collects) || 0),
    imageUrl,
    sourceUrl: `https://bgm.tv/character/${id}`,
    relatedWorks: [],
    profile: {
      source: "Bangumi",
      sourceUrl: `https://bgm.tv/character/${id}`,
      summary: boundedText(entry.summary, MAX_PROFILE_SUMMARY_LENGTH),
      attributes: bangumiProfileAttributes(entry),
    },
  };
}

function anilistCandidate(value) {
  const entry = plainObject(value);
  const id = Number(entry.id);
  const names = plainObject(entry.name);
  const name = clean(names.full) || clean(names.native);
  if (!Number.isSafeInteger(id) || id <= 0 || !name) return null;
  const aliases = uniqueStrings([
    names.full,
    names.native,
    ...(Array.isArray(names.alternative) ? names.alternative : []),
  ]);
  const relatedWorks = uniqueStrings((Array.isArray(plainObject(entry.media).nodes)
    ? plainObject(entry.media).nodes
    : []).flatMap((media) => {
    const titles = plainObject(plainObject(media).title);
    return [titles.english, titles.romaji, titles.native];
  }));
  return {
    provider: "anilist",
    candidateId: `anilist:${id}`,
    id,
    name,
    title: name,
    aliases,
    popularity: Math.max(0, Number(entry.favourites) || 0),
    imageUrl: safeHttpsUrl(plainObject(entry.image).large, new Set([ANILIST_IMAGE_ORIGIN])),
    sourceUrl: safeHttpsUrl(entry.siteUrl, new Set(["https://anilist.co"])) || `https://anilist.co/character/${id}`,
    relatedWorks,
  };
}

function nameMatch(referenceNames, candidateNames) {
  const references = uniqueStrings(referenceNames).map(normalizedCharacterName);
  const candidates = uniqueStrings(candidateNames).map(normalizedCharacterName);
  let tier = 0;
  for (const reference of references) {
    for (const candidate of candidates) {
      if (!reference || !candidate) continue;
      if (reference === candidate) tier = Math.max(tier, 3);
      else if (Math.min(reference.length, candidate.length) >= 2
        && (reference.includes(candidate) || candidate.includes(reference))) tier = Math.max(tier, 2);
    }
  }
  return tier;
}

function relatedWorkOverlap(left, right) {
  const leftNames = uniqueStrings(left).map(normalizedCharacterName);
  const rightNames = uniqueStrings(right).map(normalizedCharacterName);
  let matches = 0;
  for (const leftName of leftNames) {
    if (!leftName) continue;
    if (rightNames.some((rightName) => (
      rightName === leftName
      || (Math.min(rightName.length, leftName.length) >= 5
        && (rightName.includes(leftName) || leftName.includes(rightName)))
    ))) matches += 1;
  }
  return matches;
}

function rankedCandidates(candidates, referenceNames, referenceWorks = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.imageUrl)
    .map((candidate) => {
      const matchTier = nameMatch(referenceNames, candidate.aliases);
      const workMatches = relatedWorkOverlap(referenceWorks, candidate.relatedWorks);
      return {
        ...candidate,
        matchTier,
        workMatches,
        rankScore: (matchTier * 1_000_000)
          + (workMatches * 100_000)
          + Math.min(90_000, Math.round(Math.log2(candidate.popularity + 1) * 5_000)),
      };
    })
    .filter((candidate) => candidate.matchTier > 0)
    .sort((left, right) => right.rankScore - left.rankScore || right.popularity - left.popularity);
}

function chooseAutomaticCandidate(candidates, referenceNames, referenceWorks = []) {
  const ranked = rankedCandidates(candidates, referenceNames, referenceWorks);
  if (!ranked.length) return { status: "not-found", candidates: [] };
  if (ranked.length === 1) return { status: "matched", selected: ranked[0], candidates: ranked };
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top.matchTier > runnerUp.matchTier || top.workMatches > runnerUp.workMatches) {
    return { status: "matched", selected: top, candidates: ranked };
  }
  if (top.popularity >= Math.max(25, runnerUp.popularity * 3)) {
    return { status: "matched", selected: top, candidates: ranked };
  }
  return { status: "needs-confirmation", candidates: ranked };
}

async function searchBangumi(fetchImpl, query) {
  const url = new URL("/v0/search/characters", BANGUMI_API_ORIGIN);
  url.searchParams.set("limit", String(SEARCH_RESULT_LIMIT));
  const payload = await fetchJson(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyword: query, filter: { nsfw: false } }),
  }, "Bangumi");
  return (Array.isArray(plainObject(payload).data) ? payload.data : [])
    .map(bangumiCandidate)
    .filter(Boolean);
}

async function fetchBangumiCharacter(fetchImpl, id) {
  const payload = await fetchJson(fetchImpl, new URL(`/v0/characters/${id}`, BANGUMI_API_ORIGIN), {
    method: "GET",
  }, "Bangumi");
  return bangumiCandidate(payload);
}

async function fetchBangumiWorks(fetchImpl, id) {
  try {
    const payload = await fetchJson(fetchImpl, new URL(`/v0/characters/${id}/subjects`, BANGUMI_API_ORIGIN), {
      method: "GET",
    }, "Bangumi");
    return uniqueStrings((Array.isArray(payload) ? payload : []).flatMap((entry) => {
      const subject = plainObject(entry);
      return [subject.name_cn, subject.name];
    }));
  } catch {
    return [];
  }
}

async function searchAniList(fetchImpl, query) {
  const payload = await fetchJson(fetchImpl, ANILIST_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: ANILIST_SEARCH_QUERY, variables: { search: query } }),
  }, "AniList");
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new CharacterAvatarProviderError("AniList 角色搜索返回错误。", { code: "ANILIST_GRAPHQL_ERROR" });
  }
  const entries = plainObject(plainObject(payload).data).Page;
  return (Array.isArray(plainObject(entries).characters) ? entries.characters : [])
    .map(anilistCandidate)
    .filter(Boolean);
}

async function fetchAniListCharacter(fetchImpl, id) {
  const payload = await fetchJson(fetchImpl, ANILIST_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: ANILIST_CHARACTER_QUERY, variables: { id } }),
  }, "AniList");
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new CharacterAvatarProviderError("AniList 角色信息返回错误。", { code: "ANILIST_GRAPHQL_ERROR" });
  }
  return anilistCandidate(plainObject(plainObject(payload).data).Character);
}

function parseCandidateId(value) {
  const match = /^(bangumi|anilist):(\d+)$/u.exec(clean(value).toLocaleLowerCase());
  const id = Number(match?.[2]);
  return match && Number.isSafeInteger(id) && id > 0 ? { provider: match[1], id } : null;
}

function publicCandidate(value, { includeProfile = false } = {}) {
  const candidate = plainObject(value);
  const result = {
    candidateId: clean(candidate.candidateId),
    title: clean(candidate.title) || clean(candidate.name),
    aliases: uniqueStrings(candidate.aliases).filter((name) => (
      normalizedCharacterName(name) !== normalizedCharacterName(candidate.title)
    )).slice(0, 4),
    relatedWorks: uniqueStrings(candidate.relatedWorks).slice(0, 4),
    source: candidate.provider === "anilist" ? "AniList" : "Bangumi",
    sourceUrl: clean(candidate.sourceUrl),
  };
  if (includeProfile && candidate.provider === "bangumi") {
    const profile = plainObject(candidate.profile);
    result.profile = {
      source: "Bangumi",
      sourceUrl: clean(profile.sourceUrl) || clean(candidate.sourceUrl),
      summary: clean(profile.summary),
      attributes: (Array.isArray(profile.attributes) ? profile.attributes : []).map((entry) => ({
        name: clean(plainObject(entry).name),
        value: clean(plainObject(entry).value),
      })).filter((entry) => entry.name && entry.value),
    };
  }
  return result;
}

async function enrichBangumiCandidate(fetchImpl, candidate) {
  if (!candidate) return null;
  const relatedWorks = await fetchBangumiWorks(fetchImpl, candidate.id);
  return { ...candidate, relatedWorks };
}

async function bestAniListPortraitForBangumi(fetchImpl, character, originalQuery) {
  const searchTerms = uniqueStrings([
    character.name,
    ...character.aliases.filter((name) => /[A-Za-z]/u.test(name)),
    originalQuery,
  ]).slice(0, 3);
  for (const term of searchTerms) {
    let candidates;
    try {
      candidates = await searchAniList(fetchImpl, term);
    } catch {
      continue;
    }
    const decision = chooseAutomaticCandidate(candidates, character.aliases, character.relatedWorks);
    if (decision.status !== "matched") continue;
    const selected = decision.selected;
    const exactName = nameMatch(character.aliases, [selected.name, ...selected.aliases.slice(0, 2)]) === 3;
    if (character.relatedWorks.length && !selected.workMatches && !exactName) continue;
    return selected;
  }
  return null;
}

function matchedResult({ character, portrait, query }) {
  const fallbackPortrait = character.provider === "bangumi"
    && character.imageUrl
    && portrait.provider !== "bangumi"
    ? {
        imageUrl: character.imageUrl,
        source: "Bangumi",
        sourceUrl: character.sourceUrl,
        title: character.title,
      }
    : null;
  return {
    status: "matched",
    query,
    character: publicCandidate(character, { includeProfile: true }),
    portrait: {
      imageUrl: portrait.imageUrl,
      source: portrait.provider === "anilist" ? "AniList" : "Bangumi",
      sourceUrl: portrait.sourceUrl,
      title: portrait.title,
    },
    ...(fallbackPortrait ? { fallbackPortrait } : {}),
  };
}

async function confirmedCandidateResult({ candidateId, fetchImpl, query }) {
  const parsed = parseCandidateId(candidateId);
  if (!parsed) return { status: "invalid-candidate", query, candidates: [] };
  if (parsed.provider === "anilist") {
    const character = await fetchAniListCharacter(fetchImpl, parsed.id);
    return character?.imageUrl
      ? matchedResult({ character, portrait: character, query })
      : { status: "not-found", query, candidates: [] };
  }
  const base = await fetchBangumiCharacter(fetchImpl, parsed.id);
  if (!base) return { status: "not-found", query, candidates: [] };
  const character = await enrichBangumiCandidate(fetchImpl, base);
  const anilistPortrait = await bestAniListPortraitForBangumi(fetchImpl, character, query);
  const portrait = anilistPortrait || character;
  return portrait?.imageUrl
    ? matchedResult({ character, portrait, query })
    : { status: "not-found", query, candidates: [] };
}

/**
 * Resolves an on-demand character portrait. Chinese identity resolution is
 * backed by Bangumi while AniList is preferred for avatar-shaped artwork.
 */
export async function resolveCharacterAvatar({ candidateId = "", fetchImpl = globalThis.fetch, query = "" } = {}) {
  const resolvedQuery = clean(query);
  if (clean(candidateId)) {
    return confirmedCandidateResult({ candidateId, fetchImpl, query: resolvedQuery });
  }
  if (!resolvedQuery) return { status: "invalid-query", query: "", candidates: [] };

  const [bangumiResult, anilistResult] = await Promise.allSettled([
    searchBangumi(fetchImpl, resolvedQuery),
    searchAniList(fetchImpl, resolvedQuery),
  ]);
  const bangumiCandidates = bangumiResult.status === "fulfilled" ? bangumiResult.value : [];
  const anilistCandidates = anilistResult.status === "fulfilled" ? anilistResult.value : [];
  const directAniList = chooseAutomaticCandidate(anilistCandidates, [resolvedQuery]);
  const bangumiDecision = chooseAutomaticCandidate(bangumiCandidates, [resolvedQuery]);
  if (bangumiDecision.status === "matched") {
    const character = await enrichBangumiCandidate(fetchImpl, bangumiDecision.selected);
    const anilistPortrait = await bestAniListPortraitForBangumi(fetchImpl, character, resolvedQuery);
    const portrait = anilistPortrait || character;
    if (portrait?.imageUrl) return matchedResult({ character, portrait, query: resolvedQuery });
  }

  if (directAniList.status === "matched") {
    return matchedResult({
      character: directAniList.selected,
      portrait: directAniList.selected,
      query: resolvedQuery,
    });
  }

  const ambiguous = [];
  if (directAniList.status === "needs-confirmation") ambiguous.push(...directAniList.candidates);
  if (bangumiDecision.status === "needs-confirmation") {
    const enriched = await Promise.all(bangumiDecision.candidates.slice(0, VISIBLE_CANDIDATE_LIMIT)
      .map((candidate) => enrichBangumiCandidate(fetchImpl, candidate)));
    ambiguous.push(...enriched.filter(Boolean));
  }
  if (ambiguous.length) {
    const seen = new Set();
    const candidates = ambiguous.filter((candidate) => {
      const key = clean(candidate.candidateId);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, VISIBLE_CANDIDATE_LIMIT).map(publicCandidate);
    return { status: "needs-confirmation", query: resolvedQuery, candidates };
  }

  const unavailable = bangumiResult.status === "rejected" && anilistResult.status === "rejected";
  return {
    status: unavailable ? "unavailable" : "not-found",
    query: resolvedQuery,
    candidates: [],
  };
}

export const characterAvatarProviderOrigins = Object.freeze({
  anilistApi: ANILIST_API_URL,
  anilistImage: ANILIST_IMAGE_ORIGIN,
  bangumiApi: BANGUMI_API_ORIGIN,
  bangumiImage: BANGUMI_IMAGE_ORIGIN,
});
