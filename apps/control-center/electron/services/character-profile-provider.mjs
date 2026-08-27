import {
  normalizedCharacterName,
  resolveCharacterAvatar,
} from "./character-avatar-provider.mjs";

const BANGUMI_API_ORIGIN = "https://api.bgm.tv";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function displayNameFor(query, character) {
  const requested = clean(query);
  const title = clean(character.title);
  const aliases = [title, ...(Array.isArray(character.aliases) ? character.aliases : [])];
  return requested && aliases.some((name) => (
    normalizedCharacterName(name) === normalizedCharacterName(requested)
  )) ? requested : title;
}

/**
 * Reuses the character identity resolved for the avatar flow. Persona facts
 * come from the same Bangumi entry; the separate portrait source is omitted.
 */
export async function resolveCharacterProfile({
  candidateId = "",
  fetchImpl = globalThis.fetch,
  query = "",
} = {}) {
  const resolved = await resolveCharacterAvatar({ candidateId, fetchImpl, query });
  if (resolved.status === "needs-confirmation") {
    const candidates = (Array.isArray(resolved.candidates) ? resolved.candidates : [])
      .filter((candidate) => clean(candidate?.source) === "Bangumi");
    return candidates.length
      ? { ...resolved, candidates }
      : { status: "not-found", query: clean(query), candidates: [] };
  }
  if (resolved.status !== "matched") return resolved;

  const character = plainObject(resolved.character);
  const sourceProfile = plainObject(character.profile);
  if (clean(character.source) !== "Bangumi" || clean(sourceProfile.source) !== "Bangumi") {
    return { status: "not-found", query: clean(query), candidates: [] };
  }

  return {
    status: "matched",
    query: clean(query),
    candidateId: clean(character.candidateId),
    displayName: displayNameFor(query, character),
    profile: {
      source: "Bangumi",
      sourceUrl: clean(sourceProfile.sourceUrl) || clean(character.sourceUrl),
      summary: clean(sourceProfile.summary),
      aliases: (Array.isArray(character.aliases) ? character.aliases : []).map(clean).filter(Boolean),
      relatedWorks: (Array.isArray(character.relatedWorks) ? character.relatedWorks : []).map(clean).filter(Boolean),
      attributes: (Array.isArray(sourceProfile.attributes) ? sourceProfile.attributes : []).map((value) => {
        const entry = plainObject(value);
        return { name: clean(entry.name), value: clean(entry.value) };
      }).filter((entry) => entry.name && entry.value),
    },
  };
}

export const characterProfileProviderOrigins = Object.freeze({
  bangumi: BANGUMI_API_ORIGIN,
});
