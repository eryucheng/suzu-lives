import assert from "node:assert/strict";
import test from "node:test";

import { resolveCharacterProfile } from "../electron/services/character-profile-provider.mjs";

function jsonResponse(value) {
  return { ok: true, async json() { return value; } };
}

function bangumiCharacter({ collects = 100, id, name, title, summary = "" }) {
  return {
    id,
    name,
    summary,
    gender: "female",
    images: { large: `https://lain.bgm.tv/pic/crt/l/${id}.jpg` },
    infobox: [
      { key: "简体中文名", value: title },
      { key: "引用来源", value: "wiki" },
    ],
    stat: { collects },
  };
}

test("character profile reuses the Bangumi identity and summary from the avatar lookup", async () => {
  const calls = [];
  const result = await resolveCharacterProfile({
    query: "玛奇玛",
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      calls.push(requestUrl);
      if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
        return jsonResponse({ data: [bangumiCharacter({
          id: 71337,
          name: "マキマ",
          title: "玛奇玛",
          summary: "公安对魔特异四课的恶魔猎人。",
        })] });
      }
      if (requestUrl === "https://api.bgm.tv/v0/characters/71337/subjects") {
        return jsonResponse([{ name: "チェンソーマン", name_cn: "电锯人" }]);
      }
      if (requestUrl === "https://graphql.anilist.co") {
        const search = JSON.parse(options.body).variables.search;
        return jsonResponse({ data: { Page: { characters: search === "マキマ" ? [{
          id: 137080,
          name: { full: "Makima", native: "マキマ", alternative: ["玛奇玛"] },
          image: { large: "https://s4.anilist.co/file/anilistcdn/character/large/makima.png" },
          favourites: 20_000,
          siteUrl: "https://anilist.co/character/137080",
          media: { nodes: [{ title: { english: "Chainsaw Man", romaji: "Chainsaw Man", native: "チェンソーマン" } }] },
        }] : [] } } });
      }
      throw new Error(`unexpected request ${requestUrl}`);
    },
  });

  assert.equal(result.status, "matched");
  assert.equal(result.candidateId, "bangumi:71337");
  assert.equal(result.displayName, "玛奇玛");
  assert.deepEqual(result.profile, {
    source: "Bangumi",
    sourceUrl: "https://bgm.tv/character/71337",
    summary: "公安对魔特异四课的恶魔猎人。",
    aliases: ["マキマ"],
    relatedWorks: ["电锯人", "チェンソーマン"],
    attributes: [
      { name: "简体中文名", value: "玛奇玛" },
      { name: "性别", value: "女" },
    ],
  });
  assert.equal(Object.hasOwn(result, "portrait"), false);
  assert.equal(calls.some((url) => url.startsWith("https://zh.moegirl.org.cn")), false);
});

test("character profile keeps only Bangumi candidates when a name is ambiguous", async () => {
  const first = bangumiCharacter({ id: 1, name: "凛A", title: "凛", collects: 20 });
  const second = bangumiCharacter({ id: 2, name: "凛B", title: "凛", collects: 18 });
  const result = await resolveCharacterProfile({
    query: "凛",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
        return jsonResponse({ data: [first, second] });
      }
      if (requestUrl === "https://graphql.anilist.co") {
        return jsonResponse({ data: { Page: { characters: [] } } });
      }
      if (requestUrl.endsWith("/subjects")) {
        return jsonResponse([{ name: requestUrl.includes("/1/") ? "作品 A" : "作品 B", name_cn: "" }]);
      }
      throw new Error(`unexpected request ${requestUrl}`);
    },
  });

  assert.equal(result.status, "needs-confirmation");
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), ["bangumi:1", "bangumi:2"]);
  assert.ok(result.candidates.every((candidate) => candidate.source === "Bangumi"));
});

test("character profile does not substitute an AniList description when Bangumi has no match", async () => {
  const result = await resolveCharacterProfile({
    query: "Unknown Hero",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
        return jsonResponse({ data: [] });
      }
      if (requestUrl === "https://graphql.anilist.co") {
        return jsonResponse({ data: { Page: { characters: [{
          id: 9,
          name: { full: "Unknown Hero", native: "", alternative: [] },
          image: { large: "https://s4.anilist.co/file/anilistcdn/character/large/unknown.png" },
          favourites: 100,
          siteUrl: "https://anilist.co/character/9",
          media: { nodes: [] },
        }] } } });
      }
      throw new Error(`unexpected request ${requestUrl}`);
    },
  });

  assert.equal(result.status, "not-found");
  assert.deepEqual(result.candidates, []);
});
