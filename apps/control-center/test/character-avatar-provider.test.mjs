import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedCharacterName,
  resolveCharacterAvatar,
} from "../electron/services/character-avatar-provider.mjs";

function jsonResponse(value) {
  return {
    ok: true,
    async json() { return value; },
  };
}

function bangumiCharacter({ collects, cn, id, image, name, summary = "" }) {
  return {
    id,
    name,
    type: 1,
    summary,
    locked: false,
    stat: { comments: 0, collects },
    infobox: [
      { key: "简体中文名", value: cn },
      { key: "别名", value: [{ k: "罗马字", v: name === "初音ミク" ? "Hatsune Miku" : name }] },
    ],
    images: { large: image },
  };
}

function anilistCharacter({ alternatives = [], favourites, full, id, image, media = [], native }) {
  return {
    id,
    name: { full, native, alternative: alternatives },
    image: { large: image },
    favourites,
    siteUrl: `https://anilist.co/character/${id}`,
    media: {
      nodes: media.map((title) => ({ title: { english: title, native: title, romaji: title } })),
    },
  };
}

test("character name normalization compares translated names without punctuation or spacing", () => {
  assert.equal(normalizedCharacterName(" 遠坂 凛（Rin） "), "遠坂凛rin");
  assert.equal(normalizedCharacterName("Rin Tohsaka"), "rintohsaka");
});

test("Chinese character lookup uses Bangumi identity and prefers the matching AniList portrait", async () => {
  const calls = [];
  const wrongMiku = bangumiCharacter({
    collects: 6,
    cn: "初音未来",
    id: 184752,
    image: "https://lain.bgm.tv/pic/crt/l/wrong.jpg",
    name: "初音未來",
  });
  const correctMiku = bangumiCharacter({
    collects: 2448,
    cn: "初音未来",
    id: 10452,
    image: "https://lain.bgm.tv/pic/crt/l/miku.jpg",
    name: "初音ミク",
    summary: "以声库为基础的虚拟歌手角色。",
  });
  const portrait = anilistCharacter({
    alternatives: ["初音未来", "Hatsune Miku"],
    favourites: 3687,
    full: "Miku Hatsune",
    id: 7156,
    image: "https://s4.anilist.co/file/anilistcdn/character/large/miku.jpg",
    media: ["Project Sekai"],
    native: "初音ミク",
  });
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
      return jsonResponse({ data: [wrongMiku, correctMiku] });
    }
    if (requestUrl === "https://api.bgm.tv/v0/characters/10452/subjects") {
      return jsonResponse([{ name: "初音ミク -Project DIVA-", name_cn: "初音未来：歌姬计划" }]);
    }
    if (requestUrl === "https://graphql.anilist.co") {
      const variables = JSON.parse(options.body).variables;
      return jsonResponse({
        data: {
          Page: { characters: variables.search === "初音ミク" ? [portrait] : [] },
        },
      });
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };

  const result = await resolveCharacterAvatar({ fetchImpl, query: "初音未来" });

  assert.equal(result.status, "matched");
  assert.equal(result.character.candidateId, "bangumi:10452");
  assert.equal(result.character.title, "初音未来");
  assert.equal(result.character.profile.source, "Bangumi");
  assert.equal(result.character.profile.summary, "以声库为基础的虚拟歌手角色。");
  assert.equal(result.portrait.source, "AniList");
  assert.equal(result.portrait.imageUrl, "https://s4.anilist.co/file/anilistcdn/character/large/miku.jpg");
  assert.ok(calls.some((call) => call.url === "https://api.bgm.tv/v0/characters/10452/subjects"));
  assert.ok(calls.some((call) => (
    call.url === "https://graphql.anilist.co"
    && JSON.parse(call.options.body).variables.search === "初音ミク"
  )));
});

test("Latin alias lookup deterministically selects the strongly dominant AniList portrait", async () => {
  const artoria = anilistCharacter({
    alternatives: ["Saber (セイバー)", "King Arthur"],
    favourites: 12_597,
    full: "Artoria Pendragon",
    id: 497,
    image: "https://s4.anilist.co/file/anilistcdn/character/large/artoria.png",
    media: ["Fate/stay night"],
    native: "アルトリア・ペンドラゴン",
  });
  const nero = anilistCharacter({
    alternatives: ["Red Saber"],
    favourites: 1_522,
    full: "Nero Claudius",
    id: 51523,
    image: "https://s4.anilist.co/file/anilistcdn/character/large/nero.png",
    media: ["Fate/EXTRA"],
    native: "ネロ・クラウディウス",
  });
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
      return jsonResponse({ data: [] });
    }
    if (requestUrl === "https://graphql.anilist.co") {
      assert.equal(JSON.parse(options.body).variables.search, "Saber");
      return jsonResponse({ data: { Page: { characters: [artoria, nero] } } });
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };

  const result = await resolveCharacterAvatar({ fetchImpl, query: "Saber" });

  assert.equal(result.status, "matched");
  assert.equal(result.character.candidateId, "anilist:497");
  assert.equal(result.portrait.title, "Artoria Pendragon");
});

test("similarly ranked translated names return stable candidate IDs for confirmation", async () => {
  const first = bangumiCharacter({
    collects: 18,
    cn: "雷姆",
    id: 25660,
    image: "https://lain.bgm.tv/pic/crt/l/rem-a.jpg",
    name: "レム",
  });
  const second = bangumiCharacter({
    collects: 11,
    cn: "雷姆",
    id: 15876,
    image: "https://lain.bgm.tv/pic/crt/l/rem-b.jpg",
    name: "レーム",
  });
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
      return jsonResponse({ data: [first, second] });
    }
    if (requestUrl === "https://graphql.anilist.co") {
      return jsonResponse({ data: { Page: { characters: [] } } });
    }
    if (requestUrl.endsWith("/subjects")) {
      return jsonResponse([{ name: requestUrl.includes("25660") ? "Work A" : "Work B", name_cn: "" }]);
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };

  const result = await resolveCharacterAvatar({ fetchImpl, query: "雷姆" });

  assert.equal(result.status, "needs-confirmation");
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), [
    "bangumi:25660",
    "bangumi:15876",
  ]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.relatedWorks[0]), ["Work A", "Work B"]);
});

test("a confirmed Bangumi candidate is fetched by ID before portrait matching", async () => {
  const rin = bangumiCharacter({
    collects: 1803,
    cn: "远坂凛",
    id: 10596,
    image: "https://lain.bgm.tv/pic/crt/l/rin.jpg",
    name: "遠坂凛",
  });
  const portrait = anilistCharacter({
    alternatives: ["Rin Tousaka"],
    favourites: 13_377,
    full: "Rin Tohsaka",
    id: 498,
    image: "https://s4.anilist.co/file/anilistcdn/character/large/rin.png",
    media: ["Fate/stay night"],
    native: "遠坂凛",
  });
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl === "https://api.bgm.tv/v0/characters/10596") return jsonResponse(rin);
    if (requestUrl === "https://api.bgm.tv/v0/characters/10596/subjects") {
      return jsonResponse([{ name: "Fate/stay night", name_cn: "Fate/stay night" }]);
    }
    if (requestUrl === "https://graphql.anilist.co") {
      assert.equal(JSON.parse(options.body).variables.search, "遠坂凛");
      return jsonResponse({ data: { Page: { characters: [portrait] } } });
    }
    throw new Error(`unexpected request ${requestUrl}`);
  };

  const result = await resolveCharacterAvatar({
    candidateId: "bangumi:10596",
    fetchImpl,
    query: "远坂凛",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.character.candidateId, "bangumi:10596");
  assert.equal(result.portrait.source, "AniList");
});
