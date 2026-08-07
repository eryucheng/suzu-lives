import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "../../common/config.mjs";
import {
  appendOperation,
  cleanText,
  hasSuccessfulOperation,
  operationKey,
  SiteAutomationError,
} from "../../common/runtime.mjs";
import {
  checkGroupMessages,
  checkOwnerMessages,
  consumeConfiguredGroupMentionSignals,
  ensureGroupMentionWatchers,
  groupChatsEnabled,
  inspectGroupChatImage,
  inspectOwnerChatImage,
  ownerChatEnabled,
  pendingOwnerSharedItem,
  requestGroupPrivacyConsent,
  replyToGroup,
  replyToOwner,
  resolveDouyinFeedPage,
  shareCurrentWithOwner,
} from "./private-chat.mjs";
import {
  addVisualObservation,
  understandCurrentNote,
  understandCurrentVideo,
} from "./current-media.mjs";
import {
  recordDouyinAction,
  toAgentResult,
} from "./agent-output.mjs";

const ADAPTER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const selectors = readJson(path.join(ADAPTER_ROOT, "selectors.json"));
const RETURN_URL_KEY = "siteAutomation.douyin.returnUrl";

async function visibleLocators(page, candidates, maximum = 8) {
  const matches = [];
  for (const selector of candidates || []) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), maximum);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) {
        matches.push({ locator: item, selector, index });
      }
    }
  }
  return matches;
}

async function firstVisible(page, candidates) {
  const matches = await visibleLocators(page, candidates, 4);
  return matches[0] || null;
}

async function uniqueVisible(page, candidates, purpose) {
  const matches = await visibleLocators(page, candidates);
  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const handle = await match.locator.elementHandle().catch(() => null);
    if (!handle) continue;
    const identity = await handle.evaluate((element) => {
      if (!element.dataset.siteAutomationIdentity) {
        element.dataset.siteAutomationIdentity =
          `sa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      return element.dataset.siteAutomationIdentity;
    });
    if (!seen.has(identity)) {
      seen.add(identity);
      unique.push(match);
    }
  }
  if (unique.length === 0) {
    throw new SiteAutomationError(
      "CONTROL_NOT_FOUND",
      `Could not find the visible ${purpose} control.`,
      { candidates },
    );
  }
  if (unique.length > 1) {
    throw new SiteAutomationError(
      "CONTROL_AMBIGUOUS",
      `Found more than one visible ${purpose} control.`,
      { count: unique.length, candidates },
    );
  }
  return unique[0].locator;
}

function itemIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const pathMatch = url.pathname.match(/\/(?:video|note)\/(\d+)/u);
    return pathMatch?.[1] || url.searchParams.get("modal_id") || "";
  } catch {
    return "";
  }
}

function requireText(value, field, maximum = 100) {
  const text = cleanText(value, maximum);
  if (!text) {
    throw new SiteAutomationError(
      "TEXT_REQUIRED",
      `${field} must not be empty.`,
    );
  }
  return text;
}

function requireResultIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) {
    throw new SiteAutomationError(
      "INVALID_RESULT_INDEX",
      `Result index must be a positive integer, received: ${value}`,
    );
  }
  return index;
}

async function loginState(page) {
  if (await firstVisible(page, selectors.loginMarkers)) return "logged-out";
  if (await firstVisible(page, selectors.accountMarkers)) return "logged-in";
  return "unknown";
}

function isLiveRoomUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.pathname.includes("/root/live/") ||
      url.hostname === "live.douyin.com"
    );
  } catch {
    return false;
  }
}

async function pageObservationOnce(page) {
  const browserView = await page.evaluate(() => {
    const visibleArea = (element) => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(
        0,
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
      );
      const height = Math.max(
        0,
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
      );
      return width * height;
    };
    const routeMatch = location.pathname.match(
      /\/(video|note)\/(\d+)/u,
    );
    const preferredItemId =
      routeMatch?.[2] || new URLSearchParams(location.search).get("modal_id");
    const activeContainers = [
      ...document.querySelectorAll("[data-e2e='feed-active-video']"),
    ];
    const activeContainer =
      activeContainers.find(
        (element) =>
          preferredItemId &&
          element.getAttribute("data-e2e-vid") === preferredItemId,
      ) ||
      activeContainers
        .map((element) => ({ element, area: visibleArea(element) }))
        .filter(({ area }) => area > 0)
        .sort((left, right) => right.area - left.area)[0]?.element ||
      null;
    const detailRoot = document.querySelector("[data-e2e='video-detail']");
    const detailInfo = detailRoot?.querySelector(
      "[data-e2e='detail-video-info']",
    );
    const detailUser = detailRoot?.querySelector("[data-e2e='user-info']");
    const detailAuthorLink = detailUser?.querySelector("a[href*='/user/']");
    const pageDescription =
      document.querySelector("meta[property='og:description']")?.content ||
      document.querySelector("meta[name='description']")?.content ||
      "";
    const noteAuthorFromDescription =
      pageDescription.match(/-\s*(.+?)于\d{8}发布在抖音/u)?.[1]?.trim() ||
      "";
    const noteAuthorLink = [
      ...document.querySelectorAll("a[href*='/user/']"),
    ].find((link) => {
      const text = (link.innerText || "").replace(/\s+/gu, " ").trim();
      return (
        !String(link.href || "").includes("/user/self") &&
        text &&
        noteAuthorFromDescription &&
        text.includes(noteAuthorFromDescription)
      );
    });
    const activeId =
      activeContainer?.getAttribute("data-e2e-vid") ||
      activeContainer?.querySelector("[data-e2e-aweme-id]")?.getAttribute(
        "data-e2e-aweme-id",
      ) ||
      detailInfo?.getAttribute("data-e2e-aweme-id") ||
      "";
    const matchingInfo =
      [...document.querySelectorAll("[data-e2e='video-info']")].find(
        (element) => element.getAttribute("data-e2e-aweme-id") === activeId,
      ) ||
      activeContainer?.querySelector("[data-e2e='video-info']") ||
      detailInfo ||
      null;
    const activeLive =
      [...document.querySelectorAll("[data-e2e='feed-live']")]
        .map((element) => ({ element, area: visibleArea(element) }))
        .filter(({ area }) => area > 0)
        .sort((left, right) => right.area - left.area)[0]?.element || null;
    const isLiveRoom =
      location.pathname.includes("/root/live/") ||
      location.hostname === "live.douyin.com";
    const liveRoomId =
      location.pathname.match(/\/(?:root\/)?live\/(\d+)/u)?.[1] ||
      location.pathname.match(/^\/(\d+)\/?$/u)?.[1] ||
      "";
    const liveRoomAuthor =
      document.title.match(/^(.*?)的抖音直播间/u)?.[1] || "";
    const liveAuthorLink = activeLive?.querySelector("a[href*='/user/']");
    const liveAuthor = liveAuthorLink?.innerText || "";
    const liveCaption = liveAuthorLink?.nextElementSibling?.innerText || "";
    const liveState = isLiveRoom
      ? "room"
      : activeId
        ? null
        : activeLive
          ? "preview"
          : null;
    const activeRoot = activeContainer || detailRoot;
    const hasNoteImages = [
      ...document.querySelectorAll(
        ".note-detail-container img[src*='aweme-images'], .note-detail-container img[src*='biz_tag=aweme_images']",
      ),
    ].some((image) => visibleArea(image) > 0);
    const isNote =
      routeMatch?.[1] === "note" ||
      (Boolean(activeId) && hasNoteImages);
    const contentType = isLiveRoom
      ? "live"
      : activeId
        ? isNote
          ? "note"
          : "video"
        : liveState
          ? "live"
          : "unknown";
    const contentKey =
      liveState === "room"
        ? `live-room:${liveRoomId || location.pathname}`
        : activeId
          ? `${contentType}:${activeId}`
          : activeLive
            ? `live:${liveAuthorLink?.href || ""}|${liveAuthor}|${liveCaption}`
            : "";
    const videos =
      contentType === "note"
        ? []
        : [
            ...(activeContainer || activeLive || detailRoot || document)
              .querySelectorAll("video"),
          ]
            .map((video) => ({ video, area: visibleArea(video) }))
            .filter(({ area }) => area > 0)
            .sort((left, right) => right.area - left.area);
    const active = videos[0]?.video || null;
    let context = activeContainer || activeLive || detailRoot || active;
    for (let depth = 0; context && depth < 6; depth += 1) {
      const text = (context.innerText || "").replace(/\s+/gu, " ").trim();
      if (text.length >= 20 && text.length <= 1600) break;
      context = context.parentElement;
    }
    const activeVideoRoot = activeContainer || detailRoot;
    const largestVisibleControl = (selector) =>
      [...document.querySelectorAll(selector)]
        .map((element) => ({ element, area: visibleArea(element) }))
        .filter(({ area }) => area > 0)
        .sort((left, right) => right.area - left.area)[0]?.element || null;
    const likeControl =
      activeVideoRoot?.querySelector("[data-e2e='video-player-digg']") ||
      (isNote
        ? largestVisibleControl("[data-e2e='video-player-digg']")
        : null);
    const commentControl =
      activeVideoRoot?.querySelector("[data-e2e='feed-comment-icon']") ||
      (isNote
        ? largestVisibleControl("[data-e2e='feed-comment-icon']")
        : null);
    return {
      canonical:
        document.querySelector("link[rel='canonical']")?.href || location.href,
      description: pageDescription,
      visibleText: (context?.innerText || document.body?.innerText || "")
        .replace(/\s+/gu, " ")
        .trim(),
      videoLink: context?.querySelector?.("a[href*='/video/']")?.href || "",
      itemId: activeId,
      contentType,
      contentKey,
      liveState,
      liveRoomId,
      author: liveState === "room"
        ? liveRoomAuthor
        : activeId
          ? isNote
            ? noteAuthorFromDescription ||
              noteAuthorLink?.innerText ||
              detailUser?.querySelector("img[alt]")?.getAttribute("alt") ||
              detailAuthorLink?.innerText ||
              ""
            : matchingInfo?.querySelector("[data-e2e='feed-video-nickname']")
                ?.innerText ||
              detailUser?.querySelector("img[alt]")?.getAttribute("alt") ||
              detailAuthorLink?.innerText ||
              ""
          : liveAuthor,
      caption: liveState === "room"
        ? ""
        : activeId
          ? matchingInfo?.querySelector("[data-e2e='video-desc']")?.innerText ||
            matchingInfo?.querySelector("h1")?.innerText ||
            ""
          : liveCaption,
      profileUrl: activeId
        ? isNote
          ? noteAuthorLink?.href || detailAuthorLink?.href || ""
          : detailAuthorLink?.href || ""
        : liveAuthorLink?.href || "",
      engagement: activeVideoRoot
        ? {
            liked: likeControl
              ? likeControl.getAttribute("data-e2e-state") ===
                "video-player-is-digged"
              : null,
            likeCount: likeControl?.innerText || "",
            commentCount: commentControl?.innerText || "",
          }
        : null,
      video: active
        ? {
            paused: active.paused,
            duration: Number.isFinite(active.duration) ? active.duration : null,
            currentTime: Number.isFinite(active.currentTime)
              ? active.currentTime
              : null,
            muted: active.muted,
            source: active.currentSrc || active.src || "",
          }
        : null,
    };
  });

  const url = page.url();
  const itemId =
    browserView.contentType === "live"
      ? ""
      : browserView.itemId ||
        itemIdFromUrl(url) ||
        itemIdFromUrl(browserView.canonical) ||
        itemIdFromUrl(browserView.videoLink) ||
        "";
  const hasActiveContent =
    ["live", "note"].includes(browserView.contentType) ||
    Boolean(browserView.video);
  return {
    url,
    title: cleanText(await page.title(), 200),
    pageType: itemId
      ? browserView.contentType === "note"
        ? "note"
        : "video"
      : browserView.liveState === "room"
        ? "live-room"
        : browserView.liveState === "preview"
          ? "live"
          : url.includes("/user/")
            ? "profile"
            : url.includes("/search/")
              ? "search"
            : "feed",
    contentType: browserView.contentType,
    contentKey: browserView.contentKey,
    liveState: browserView.liveState,
    ...(browserView.liveRoomId
      ? { liveRoomId: browserView.liveRoomId }
      : {}),
    loginState: await loginState(page),
    itemId,
    author: hasActiveContent ? cleanText(browserView.author, 120) : "",
    caption:
      cleanText(browserView.caption, 500) ||
      (["video", "note"].includes(browserView.contentType)
        ? cleanText(browserView.description, 500)
        : ""),
    visibleText: cleanText(browserView.visibleText, 800),
    engagement: browserView.engagement,
    video: browserView.video,
    ...(browserView.liveState === "preview"
      ? { profileUrl: browserView.profileUrl }
      : {}),
  };
}

async function pageObservation(page) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await page.waitForTimeout(attempt === 1 ? 250 : 650);
    try {
      const observation = await pageObservationOnce(page);
      if (
        attempt < 3 &&
        observation.video &&
        observation.itemId &&
        (!observation.author || !observation.caption)
      ) {
        continue;
      }
      return observation;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (
        !message.includes("Execution context was destroyed") &&
        !message.includes("Cannot find context with specified id") &&
        !message.includes("Target page, context or browser has been closed")
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

function requireLoggedIn(observation) {
  if (observation.loginState === "logged-out") {
    throw new SiteAutomationError(
      "LOGIN_REQUIRED",
      "This action requires an account logged in to the dedicated Chrome profile.",
    );
  }
  if (observation.loginState !== "logged-in") {
    throw new SiteAutomationError(
      "LOGIN_STATE_UNKNOWN",
      "The adapter could not confirm login state, so it refused a state-changing action.",
    );
  }
}

function parseOnOff(value, fallback = "on") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!["on", "off"].includes(normalized)) {
    throw new SiteAutomationError(
      "INVALID_STATE",
      `State must be on or off, received: ${value}`,
    );
  }
  return normalized;
}

async function observe(page) {
  return { status: "ok", observation: await pageObservation(page) };
}

async function observeWithVision(page, config) {
  const observation = await pageObservation(page);
  return {
    status: "ok",
    observation: await addVisualObservation({
      page,
      observation,
      config,
    }),
  };
}

async function collectSearchResults(page, maximum = 8) {
  const rawResults = await page.evaluate((limit) => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const compact = (value, maximumLength) =>
      String(value || "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximumLength);
    const results = [];
    const seen = new Set();
    const anchors = [...document.querySelectorAll("a[href*='/video/']")];
    for (const anchor of anchors) {
      if (!isVisible(anchor)) continue;
      const href = anchor.href || "";
      const itemId = href.match(/\/video\/(\d+)/u)?.[1] || "";
      if (!itemId || seen.has(itemId)) continue;

      let card = anchor;
      for (let depth = 0; depth < 6; depth += 1) {
        const parent = card.parentElement;
        if (!parent) break;
        const distinctVideoIds = new Set(
          [...parent.querySelectorAll("a[href*='/video/']")]
            .map((item) => item.href.match(/\/video\/(\d+)/u)?.[1] || "")
            .filter(Boolean),
        );
        if (distinctVideoIds.size > 1) break;
        card = parent;
      }

      const authorLink = card.querySelector("a[href*='/user/']");
      const cardText = compact(card.innerText, 320);
      const title =
        compact(anchor.getAttribute("title"), 240) ||
        compact(anchor.querySelector("img")?.getAttribute("alt"), 240) ||
        cardText;
      const authorFromText =
        cardText.match(
          /@(.+?)\s+(?:刚刚|今天|昨天|\d+\s*(?:秒|分钟|小时|天|周|个月|月|年)前)$/u,
        )?.[1] || "";
      const author =
        compact(authorLink?.innerText, 80) ||
        compact(authorFromText, 80);
      results.push({
        index: results.length + 1,
        itemId,
        author,
        caption: title,
        url: href,
      });
      seen.add(itemId);
      if (results.length >= limit) break;
    }
    return results;
  }, maximum);

  return rawResults.map((result, position) => ({
    index: position + 1,
    itemId: cleanText(result.itemId, 40),
    author: cleanText(result.author, 80),
    caption: cleanText(result.caption, 240),
    url: result.url,
  }));
}

async function search(page, keywordValue) {
  const keyword = requireText(keywordValue, "Search keyword");
  const beforeUrl = page.url();
  await page
    .evaluate(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key: RETURN_URL_KEY, value: beforeUrl },
    )
    .catch(() => null);

  const target = new URL(
    `/search/${encodeURIComponent(keyword)}`,
    "https://www.douyin.com",
  );
  target.searchParams.set("type", "video");
  await page.goto(target.href, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(
      () => document.querySelector("a[href*='/video/']"),
      undefined,
      { timeout: 12000 },
    )
    .catch(() => null);
  await page.waitForTimeout(700);

  const results = await collectSearchResults(page);
  return {
    status: results.length > 0 ? "ok" : "empty",
    changed: page.url() !== beforeUrl,
    query: keyword,
    resultCount: results.length,
    results,
    observation: await pageObservation(page),
  };
}

async function openSearchResult(page, indexValue) {
  if (!page.url().includes("/search/")) {
    throw new SiteAutomationError(
      "SEARCH_PAGE_REQUIRED",
      "Run search before opening a search result.",
    );
  }
  const index = requireResultIndex(indexValue);
  const results = await collectSearchResults(page);
  const selected = results[index - 1];
  if (!selected) {
    throw new SiteAutomationError(
      "SEARCH_RESULT_NOT_FOUND",
      `Search result ${index} is unavailable.`,
      { requestedIndex: index, availableResults: results.length },
    );
  }

  const beforeUrl = page.url();
  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, value),
    { key: RETURN_URL_KEY, value: beforeUrl },
  );
  await page.goto(selected.url, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(
      (itemId) => {
        const detailId = document
          .querySelector("[data-e2e='detail-video-info']")
          ?.getAttribute("data-e2e-aweme-id");
        const feedVideo = document.querySelector(
          `[data-e2e='feed-active-video'][data-e2e-vid='${itemId}']`,
        );
        const visibleVideo = [...document.querySelectorAll("video")].some(
          (video) => {
            const rect = video.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
        );
        return (detailId === itemId || Boolean(feedVideo)) && visibleVideo;
      },
      selected.itemId,
      { timeout: 12000 },
    )
    .catch(() => null);
  await page.waitForTimeout(700);

  return {
    status: "ok",
    changed: page.url() !== beforeUrl,
    openedResult: selected,
    observation: await pageObservation(page),
  };
}

function hasRecommendationContent(observation) {
  return (
    (observation.contentType === "video" &&
      Boolean(observation.itemId) &&
      Boolean(observation.video)) ||
    observation.liveState === "preview"
  );
}

async function feed(page) {
  const beforeUrl = page.url();
  const existing = await pageObservation(page);
  if (existing.liveState === "room") {
    throw new SiteAutomationError(
      "ACTION_REQUIRES_EXIT_LIVE",
      "Exit the live room before returning to the recommendation feed.",
    );
  }
  if (
    hasRecommendationContent(existing) &&
    page.url().includes("recommend=1")
  ) {
    return { status: "ok", changed: false, observation: existing };
  }
  let observation = existing;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const link = page.getByRole("link", { name: "推荐", exact: true });
    if ((await link.count()) !== 1 || !(await link.isVisible())) {
      throw new SiteAutomationError(
        "RECOMMENDATION_ENTRY_NOT_FOUND",
        "Could not find one visible Douyin recommendation entry.",
      );
    }
    await link.click();
    await page
      .waitForFunction(
        () => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          return [
            ...document.querySelectorAll(
              "[data-e2e='feed-active-video'][data-e2e-vid], [data-e2e='feed-live']",
            ),
          ].some(visible);
        },
        undefined,
        { timeout: 12000 },
      )
      .catch(() => null);
    await page.waitForTimeout(500);
    observation = await pageObservation(page);
    if (hasRecommendationContent(observation)) break;
    if (observation.loginState === "logged-out") break;
    await page.waitForTimeout(600);
  }
  if (!hasRecommendationContent(observation)) {
    const code =
      observation.loginState === "logged-out"
        ? "LOGIN_REQUIRED"
        : "ACTIVE_VIDEO_NOT_FOUND";
    throw new SiteAutomationError(
      code,
      observation.loginState === "logged-out"
        ? "Douyin redirected the unsigned account away from the continuous recommendation feed."
        : "The recommendation page opened, but no active video or live recommendation was found after two attempts.",
      { observation },
    );
  }
  return {
    status: "ok",
    changed: page.url() !== beforeUrl,
    observation,
  };
}

async function next(page) {
  const before = await pageObservation(page);
  if (before.liveState === "room") {
    throw new SiteAutomationError(
      "ACTION_REQUIRES_EXIT_LIVE",
      "The live room has its own continuous live stream. Run exit-live before continuing through normal recommendations.",
    );
  }
  if (!hasRecommendationContent(before)) {
    throw new SiteAutomationError(
      "ACTIVE_FEED_ITEM_NOT_FOUND",
      "No active video or live recommendation is visible. Run the feed action before next.",
    );
  }
  const button = await uniqueVisible(page, selectors.nextButton, "next video");
  await button.click();
  await page
    .waitForFunction(
      (previousKey) => {
        const activeVideo = document.querySelector(
          "[data-e2e='feed-active-video']",
        );
        const videoId = activeVideo?.getAttribute("data-e2e-vid") || "";
        if (videoId) return `video:${videoId}` !== previousKey;
        const detailVideoId =
          document
            .querySelector("[data-e2e='detail-video-info']")
            ?.getAttribute("data-e2e-aweme-id") ||
          location.pathname.match(/\/video\/(\d+)/u)?.[1] ||
          "";
        if (detailVideoId) {
          return `video:${detailVideoId}` !== previousKey;
        }
        const visibleArea = (element) => {
          const rect = element.getBoundingClientRect();
          const width = Math.max(
            0,
            Math.min(rect.right, innerWidth) - Math.max(rect.left, 0),
          );
          const height = Math.max(
            0,
            Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0),
          );
          return width * height;
        };
        const live =
          [...document.querySelectorAll("[data-e2e='feed-live']")]
            .map((element) => ({ element, area: visibleArea(element) }))
            .filter(({ area }) => area > 0)
            .sort((left, right) => right.area - left.area)[0]?.element || null;
        if (!live) return false;
        const author = live.querySelector("a[href*='/user/']");
        const key = `live:${author?.href || ""}|${author?.innerText || ""}|${
          author?.nextElementSibling?.innerText || ""
        }`;
        return key !== previousKey;
      },
      before.contentKey,
      { timeout: 6000 },
    )
    .catch(() => null);
  await page.waitForTimeout(400);
  const after = await pageObservation(page);
  const beforeKey =
    before.contentKey || `${before.url}|${before.visibleText}`;
  const afterKey = after.contentKey || `${after.url}|${after.visibleText}`;
  return {
    status: beforeKey === afterKey ? "unchanged" : "ok",
    changed: beforeKey !== afterKey,
    observation: after,
  };
}

async function enterLive(page) {
  const before = await pageObservation(page);
  if (before.liveState === "room") {
    return {
      status: "ok",
      changed: false,
      observation: before,
    };
  }
  if (before.liveState !== "preview") {
    throw new SiteAutomationError(
      "LIVE_PREVIEW_NOT_FOUND",
      "No live recommendation preview is currently visible.",
    );
  }

  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, value),
    { key: RETURN_URL_KEY, value: page.url() },
  );
  const entry = await uniqueVisible(
    page,
    selectors.liveEntry,
    "live room entry",
  );
  await entry.click();
  await page
    .waitForURL((url) => isLiveRoomUrl(url.href), { timeout: 10000 })
    .catch(() => null);
  await page.waitForTimeout(500);

  const after = await pageObservation(page);
  if (after.liveState !== "room") {
    throw new SiteAutomationError(
      "LIVE_ROOM_ENTRY_NOT_CONFIRMED",
      "The live preview was clicked, but the live room did not open.",
      { before, after },
    );
  }
  return {
    status: "ok",
    changed: true,
    observation: after,
  };
}

async function exitLive(page) {
  const before = await pageObservation(page);
  if (before.liveState !== "room") {
    throw new SiteAutomationError(
      "LIVE_ROOM_NOT_OPEN",
      "The current page is not an entered live room.",
    );
  }

  const exit = await uniqueVisible(
    page,
    selectors.liveExit,
    "live room exit",
  );
  await exit.click();
  await page
    .waitForURL((url) => !isLiveRoomUrl(url.href), { timeout: 10000 })
    .catch(() => null);
  await page.waitForTimeout(600);

  const after = await pageObservation(page);
  if (after.liveState === "room") {
    throw new SiteAutomationError(
      "LIVE_ROOM_EXIT_NOT_CONFIRMED",
      "The live room exit control was clicked, but the page remained in the live room.",
      { before, after },
    );
  }
  return {
    status: "ok",
    changed: true,
    observation: after,
  };
}

async function play(page, desiredState) {
  const state = parseOnOff(desiredState);
  const visibleVideos = page.locator(
    "[data-e2e='feed-active-video'] video:visible, [data-e2e='feed-live'] video:visible, .LivePlayer_Preview video:visible",
  );
  if ((await visibleVideos.count()) === 0) {
    throw new SiteAutomationError("VIDEO_NOT_FOUND", "No visible video was found.");
  }
  const video = visibleVideos.first();
  const beforePaused = await video.evaluate((element) => element.paused);
  const wantsPaused = state === "off";
  if (beforePaused !== wantsPaused) {
    await video.evaluate(async (element, shouldPause) => {
      if (shouldPause) element.pause();
      else await element.play();
    }, wantsPaused);
  }
  const afterPaused = await video.evaluate((element) => element.paused);
  return {
    status: "ok",
    changed: beforePaused !== afterPaused,
    playing: !afterPaused,
    observation: await pageObservation(page),
  };
}

async function like(page, config, desiredState) {
  const observation = await pageObservation(page);
  requireLoggedIn(observation);
  if (observation.contentType === "live") {
    throw new SiteAutomationError(
      "ACTION_UNAVAILABLE_FOR_LIVE",
      "Liking live content is not registered.",
    );
  }
  const state = parseOnOff(desiredState);
  const liked = observation.engagement?.liked;
  if (typeof liked !== "boolean") {
    throw new SiteAutomationError(
      "LIKE_STATE_UNKNOWN",
      "The current video's like state could not be read.",
    );
  }
  const wantsLiked = state === "on";
  if (liked === wantsLiked) {
    return { status: "ok", changed: false, liked, observation };
  }

  const button = await uniqueVisible(page, selectors.likeButton, "like");
  await button.click();
  await page
    .waitForFunction(
      ({ itemId, wantsLiked }) => {
        const active = document.querySelector(
          `[data-e2e='feed-active-video'][data-e2e-vid='${itemId}']`,
        );
        const state = active
          ?.querySelector("[data-e2e='video-player-digg']")
          ?.getAttribute("data-e2e-state");
        return (
          state ===
          (wantsLiked
            ? "video-player-is-digged"
            : "video-player-no-digged")
        );
      },
      { itemId: observation.itemId, wantsLiked },
      { timeout: 4000 },
    )
    .catch(() => null);
  const afterObservation = await pageObservation(page);
  const afterLiked = afterObservation.engagement?.liked;
  if (afterLiked !== wantsLiked) {
    throw new SiteAutomationError(
      "LIKE_STATE_NOT_CONFIRMED",
      "The requested final like state could not be confirmed.",
    );
  }
  const key = operationKey(
    "douyin",
    observation.itemId || observation.url,
    "like",
    { state },
  );
  appendOperation(config.actionLogPath, {
    key,
    site: "douyin",
    itemId: observation.itemId,
    action: "like",
    payload: { state },
    status: "success",
  });
  return {
    status: "ok",
    changed: true,
    liked: afterLiked,
    observation: afterObservation,
  };
}

function optionEnabled(value) {
  return (
    value === true ||
    ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
  );
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (
    !Number.isInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new SiteAutomationError(
      "INVALID_NUMBER_OPTION",
      `${field} must be an integer between ${minimum} and ${maximum}.`,
      { field, value },
    );
  }
  return number;
}

async function fieldText(locator) {
  return locator.evaluate((element) =>
    "value" in element ? element.value : element.innerText || element.textContent || "",
  );
}

async function secondaryVerificationVisible(page) {
  return page
    .locator("#uc-second-verify")
    .isVisible()
    .catch(() => false);
}

async function renderedCommentText(locator) {
  return locator.evaluate((element) => {
    const content =
      element.querySelector(".FduGc_lz") ||
      element.querySelector("[class*='comment-item-content']") ||
      element;
    const collect = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.tagName === "IMG" && node.getAttribute("alt")) {
        return node.getAttribute("alt");
      }
      if (node.tagName === "BR") return "\n";
      return [...node.childNodes].map(collect).join("");
    };
    return collect(content).replace(/\s+/gu, " ").trim();
  });
}

async function matchingCommentItems(page, content) {
  const items = page.locator("[data-e2e='comment-item']");
  const matches = [];
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const itemText = cleanText(await renderedCommentText(item), 500);
    if (itemText === content) matches.push(item);
  }
  return matches;
}

async function commentIdentity(locator) {
  const rawId = await locator
    .locator("[data-e2e='video-comment-more'] [id^='tooltip_']")
    .first()
    .getAttribute("id")
    .catch(() => "");
  return String(rawId || "").replace(/^tooltip_/u, "");
}

async function clickCurrentCommentButton(page, itemId) {
  return page.evaluate(
    ({ candidates, expectedItemId }) => {
      const visibleArea = (element) => {
        const rect = element.getBoundingClientRect();
        return (
          Math.max(
            0,
            Math.min(rect.right, innerWidth) - Math.max(rect.left, 0),
          ) *
          Math.max(
            0,
            Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0),
          )
        );
      };
      const controls = candidates.flatMap((selector) => [
        ...document.querySelectorAll(selector),
      ]);
      const unique = [...new Set(controls)]
        .map((element) => ({
          element,
          itemId:
            element.closest("[data-e2e-vid]")?.getAttribute("data-e2e-vid") ||
            "",
          area: visibleArea(element),
        }))
        .filter(({ area }) => area > 0);
      const matching = expectedItemId
        ? unique.filter((entry) => entry.itemId === expectedItemId)
        : unique;
      const target = (matching.length > 0 ? matching : unique).sort(
        (left, right) => right.area - left.area,
      )[0];
      if (!target) return false;
      target.element.click();
      return true;
    },
    {
      candidates: selectors.commentButton,
      expectedItemId: String(itemId || ""),
    },
  );
}

async function ensureCommentPanel(page, itemId = "") {
  let activatorMatch = await firstVisible(page, selectors.commentActivator);
  if (!activatorMatch) {
    const clicked = await clickCurrentCommentButton(page, itemId);
    if (!clicked) {
      throw new SiteAutomationError(
        "CONTROL_NOT_FOUND",
        "Could not find the current content's comment control.",
        { itemId },
      );
    }
    await page
      .locator(selectors.commentActivator[0])
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => null);
    activatorMatch = await firstVisible(page, selectors.commentActivator);
  }
  if (!activatorMatch) {
    throw new SiteAutomationError(
      "COMMENT_PANEL_NOT_OPEN",
      "The comment panel did not expose its editor activator.",
    );
  }
}

async function loadVisibleComments(page, minimumCount) {
  const items = page.locator("[data-e2e='comment-item']");
  let previousCount = -1;
  let unchangedAttempts = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const visible = [];
    const count = await items.count();
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      if (await item.isVisible().catch(() => false)) visible.push(item);
    }
    if (visible.length >= minimumCount) {
      return visible;
    }
    unchangedAttempts =
      visible.length === previousCount ? unchangedAttempts + 1 : 0;
    if (unchangedAttempts >= 2) return visible;
    previousCount = visible.length;
    await visible.at(-1)?.scrollIntoViewIfNeeded().catch(() => null);
    await page.waitForTimeout(650);
  }
  const visible = [];
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    if (await item.isVisible().catch(() => false)) visible.push(item);
  }
  return visible;
}

function compactCount(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)(万)?/u);
  if (!match) return null;
  const number = Number(match[1]) * (match[2] ? 10_000 : 1);
  return Number.isFinite(number) ? Math.round(number) : null;
}

async function structuredComment(locator, index) {
  return locator.evaluate((element, position) => {
    const collect = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.tagName === "IMG" && node.getAttribute("alt")) {
        return node.getAttribute("alt");
      }
      if (node.tagName === "BR") return "\n";
      return [...node.childNodes].map(collect).join("");
    };
    const content = element.querySelector(".FduGc_lz");
    const authorLinks = [
      ...element.querySelectorAll("a[href*='/user/']"),
    ];
    const authorLink =
      authorLinks.find((link) => (link.innerText || "").trim()) ||
      authorLinks[0];
    const metadata = (
      element.querySelector(".VAQA49VP")?.innerText || ""
    )
      .replace(/\s+/gu, " ")
      .trim();
    const statsText = (
      element.querySelector(".comment-item-stats-container")?.innerText ||
      ""
    )
      .replace(/\s+/gu, " ")
      .trim();
    const moreId =
      element
        .querySelector("[data-e2e='video-comment-more'] [id^='tooltip_']")
        ?.getAttribute("id")
        ?.replace(/^tooltip_/u, "") || "";
    const replyText = (element.innerText || "").match(
      /展开\s*(\d+)\s*条回复/u,
    );
    const likeText = statsText.match(/^(\d+(?:\.\d+)?万?)/u);
    const avatarAuthor = (
      element.querySelector(".comment-item-avatar img[alt]")?.getAttribute(
        "alt",
      ) || ""
    )
      .replace(/头像$/u, "")
      .trim();
    let text = collect(content).replace(/\s+/gu, " ").trim();
    const hasImageComment = Boolean(
      content?.querySelector(
        ".TCmy7KLE, img[src*='aweme_comment'], img[src*='biz_tag=aweme_comment']",
      ),
    );
    const hasText = Boolean(text);
    if (!text && hasImageComment) text = "[图片评论]";
    return {
      index: position,
      commentId: moreId,
      author:
        (authorLink?.innerText || "").replace(/\s+/gu, " ").trim() ||
        avatarAuthor,
      text,
      metadata,
      likeCount: likeText?.[1] || "0",
      replyCount: Number(replyText?.[1] || 0),
      authorUrl: authorLink?.href || "",
      contentType: hasImageComment
        ? hasText
          ? "mixed"
          : "image"
        : "text",
    };
  }, index);
}

async function readComments(page, options) {
  const observation = await pageObservation(page);
  if (observation.contentType === "live") {
    throw new SiteAutomationError(
      "ACTION_UNAVAILABLE_FOR_LIVE",
      "Reading live-room comments is not registered.",
    );
  }
  if (!observation.itemId) {
    throw new SiteAutomationError(
      "CONTENT_ID_UNKNOWN",
      "The current video's or note's identifier could not be determined.",
    );
  }
  const offset = boundedInteger(
    options.offset,
    0,
    0,
    200,
    "offset",
  );
  const limit = boundedInteger(
    options.limit,
    10,
    1,
    30,
    "limit",
  );
  await ensureCommentPanel(page, observation.itemId);
  const visibleItems = await loadVisibleComments(page, offset + limit);
  const selected = visibleItems.slice(offset, offset + limit);
  const comments = [];
  for (let index = 0; index < selected.length; index += 1) {
    comments.push(await structuredComment(selected[index], offset + index + 1));
  }
  const reportedTotal = compactCount(
    observation.engagement?.commentCount,
  );
  return {
    status: "ok",
    changed: false,
    observation,
    comments,
    offset,
    limit,
    loadedCommentCount: visibleItems.length,
    hasMore:
      reportedTotal !== null
        ? offset + selected.length < reportedTotal
        : selected.length === limit &&
          visibleItems.length >= offset + selected.length,
  };
}

async function commentOwnedByCurrentAccount(page, locator) {
  await locator.hover();
  const more = locator.locator("[data-e2e='video-comment-more']");
  await more.click();
  const deleteControl = more.getByText("删除评论", { exact: true });
  await deleteControl
    .waitFor({ state: "visible", timeout: 1200 })
    .catch(() => null);
  const owned = await deleteControl.isVisible().catch(() => false);
  await page.keyboard.press("Escape").catch(() => null);
  return owned;
}

async function comment(page, config, text, dryRunValue) {
  const content = cleanText(text, 500);
  if (!content) {
    throw new SiteAutomationError(
      "COMMENT_TEXT_REQUIRED",
      "Comment text is required.",
    );
  }
  const observation = await pageObservation(page);
  requireLoggedIn(observation);
  if (observation.contentType === "live") {
    throw new SiteAutomationError(
      "ACTION_UNAVAILABLE_FOR_LIVE",
      "Commenting on live content is not registered.",
    );
  }
  if (!observation.itemId) {
    throw new SiteAutomationError(
      "VIDEO_ID_UNKNOWN",
      "The current video could not be identified, so duplicate-safe commenting is unavailable.",
    );
  }
  const dryRun = optionEnabled(dryRunValue);

  await ensureCommentPanel(page, observation.itemId);
  const key = operationKey("douyin", observation.itemId, "comment", {
    text: content,
  });
  if (!dryRun && hasSuccessfulOperation(config.actionLogPath, key)) {
    return {
      status: "duplicate-suppressed",
      changed: false,
      deliveryConfirmed: true,
      observation,
    };
  }
  if (!dryRun) {
    const existingMatches = await matchingCommentItems(page, content);
    if (
      existingMatches.length === 1 &&
      (await commentOwnedByCurrentAccount(page, existingMatches[0]))
    ) {
      const existingCommentId = await commentIdentity(existingMatches[0]);
      appendOperation(config.actionLogPath, {
        key,
        site: "douyin",
        itemId: observation.itemId,
        commentId: existingCommentId,
        action: "comment",
        payload: { text: content },
        status: "success",
        deliveryConfirmed: true,
        reconciled: true,
      });
      return {
        status: "duplicate-suppressed",
        changed: false,
        deliveryConfirmed: true,
        commentId: existingCommentId,
        reconciled: true,
        observation,
      };
    }
  }
  const activator = await uniqueVisible(
    page,
    selectors.commentActivator,
    "comment editor activator",
  );
  await activator.click();
  await page.waitForTimeout(200);
  const input = await uniqueVisible(
    page,
    selectors.commentInput,
    "comment input",
  );
  await input.click();
  try {
    await input.fill(content);
  } catch {
    await page.keyboard.press("Control+A");
    await page.keyboard.type(content);
  }
  const enteredText = cleanText(await fieldText(input), 500);
  if (enteredText !== content) {
    throw new SiteAutomationError(
      "COMMENT_INPUT_NOT_CONFIRMED",
      "The requested comment text was not present in the input.",
      { enteredText },
    );
  }
  if (dryRun) {
    try {
      await uniqueVisible(
        page,
        selectors.commentSubmit,
        "comment submit",
      );
      return {
        status: "dry-run",
        changed: false,
        ready: true,
        deliveryConfirmed: false,
        observation,
      };
    } finally {
      await input.fill("").catch(async () => {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      });
      const close = await firstVisible(page, selectors.commentClose);
      await close?.locator.click().catch(() => null);
    }
  }

  const submit = await uniqueVisible(
    page,
    selectors.commentSubmit,
    "comment submit",
  );
  const matchingBefore = (await matchingCommentItems(page, content)).length;
  await submit.click();
  await page.waitForTimeout(500);
  if (await secondaryVerificationVisible(page)) {
    appendOperation(config.actionLogPath, {
      key,
      site: "douyin",
      itemId: observation.itemId,
      action: "comment",
      payload: { text: content },
      status: "verification-required",
    });
    throw new SiteAutomationError(
      "SECONDARY_VERIFICATION_REQUIRED",
      "Douyin requires an account verification before this comment can be published. Complete it in the dedicated Chrome window, then retry.",
    );
  }
  let deliveryConfirmed = false;
  let confirmedCommentId = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const matchingAfter = await matchingCommentItems(page, content);
    if (matchingAfter.length > matchingBefore) {
      deliveryConfirmed = true;
      confirmedCommentId =
        (await commentIdentity(matchingAfter[matchingAfter.length - 1])) || "";
      break;
    }
    await page.waitForTimeout(350);
  }
  if (!deliveryConfirmed) {
    appendOperation(config.actionLogPath, {
      key,
      site: "douyin",
      itemId: observation.itemId,
      action: "comment",
      payload: { text: content },
      status: "not-confirmed",
    });
    throw new SiteAutomationError(
      "COMMENT_NOT_CONFIRMED",
      "The comment could not be confirmed in the current video's comment list, so it was not recorded as successfully published.",
    );
  }
  appendOperation(config.actionLogPath, {
    key,
    site: "douyin",
    itemId: observation.itemId,
    action: "comment",
    payload: { text: content },
    status: "success",
    deliveryConfirmed,
  });
  return {
    status: "ok",
    changed: true,
    deliveryConfirmed,
    text: content,
    commentId: confirmedCommentId,
    observation: await pageObservation(page),
  };
}

async function deleteComment(page, config, text) {
  const content = cleanText(text, 500);
  if (!content) {
    throw new SiteAutomationError(
      "COMMENT_TEXT_REQUIRED",
      "The exact text of the comment to delete is required.",
    );
  }
  const observation = await pageObservation(page);
  requireLoggedIn(observation);
  if (!observation.itemId) {
    throw new SiteAutomationError(
      "VIDEO_ID_UNKNOWN",
      "The current video could not be identified.",
    );
  }
  await ensureCommentPanel(page, observation.itemId);
  const matches = await matchingCommentItems(page, content);
  if (matches.length === 0) {
    throw new SiteAutomationError(
      "COMMENT_NOT_FOUND",
      "No visible comment exactly matched the requested text.",
      { text: content },
    );
  }
  if (matches.length > 1) {
    throw new SiteAutomationError(
      "COMMENT_AMBIGUOUS",
      "More than one visible comment exactly matched the requested text.",
      { text: content, count: matches.length },
    );
  }

  const target = matches[0];
  const commentId = await commentIdentity(target);
  if (!commentId) {
    throw new SiteAutomationError(
      "COMMENT_ID_UNKNOWN",
      "The matched comment did not expose a stable identifier.",
    );
  }
  await target.hover();
  const more = target.locator("[data-e2e='video-comment-more']");
  await more.click();
  const deleteControl = more.getByText("删除评论", { exact: true });
  await deleteControl
    .waitFor({ state: "visible", timeout: 2500 })
    .catch(() => null);
  if (!(await deleteControl.isVisible().catch(() => false))) {
    throw new SiteAutomationError(
      "COMMENT_DELETE_NOT_AVAILABLE",
      "The matched comment did not expose the owner's delete control.",
      { text: content, commentId },
    );
  }
  await deleteControl.click();
  const identityLocator = page.locator(`#tooltip_${commentId}`);
  await identityLocator
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => null);
  if ((await identityLocator.count()) > 0) {
    throw new SiteAutomationError(
      "COMMENT_DELETE_NOT_CONFIRMED",
      "The comment still exists after the delete action.",
      { text: content, commentId },
    );
  }

  const commentKey = operationKey("douyin", observation.itemId, "comment", {
    text: content,
  });
  appendOperation(config.actionLogPath, {
    key: commentKey,
    site: "douyin",
    itemId: observation.itemId,
    commentId,
    action: "comment",
    payload: { text: content },
    status: "deleted",
  });
  const key = operationKey(
    "douyin",
    observation.itemId,
    "delete-comment",
    { text: content, commentId },
  );
  appendOperation(config.actionLogPath, {
    key,
    site: "douyin",
    itemId: observation.itemId,
    commentId,
    action: "delete-comment",
    payload: { text: content },
    status: "success",
  });
  return {
    status: "ok",
    changed: true,
    deleted: true,
    commentId,
    observation: await pageObservation(page),
  };
}

async function profile(page) {
  const observation = await pageObservation(page);
  if (observation.liveState === "room") {
    throw new SiteAutomationError(
      "ACTION_REQUIRES_EXIT_LIVE",
      "Exit the live room before opening an author profile.",
    );
  }
  const beforeUrl = page.url();
  const author = await uniqueVisible(
    page,
    selectors.authorLink,
    "author profile",
  );
  const href = await author.getAttribute("href");
  if (!href) {
    throw new SiteAutomationError(
      "AUTHOR_URL_MISSING",
      "The current author control has no profile URL.",
    );
  }
  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, value),
    { key: RETURN_URL_KEY, value: beforeUrl },
  );
  await page.goto(new URL(href, beforeUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(500);
  return {
    status: "ok",
    changed: page.url() !== beforeUrl,
    observation: await pageObservation(page),
  };
}

async function back(page) {
  const current = await pageObservation(page);
  if (current.liveState === "room") {
    return exitLive(page);
  }
  const beforeUrl = page.url();
  const storedReturnUrl = await page
    .evaluate((key) => sessionStorage.getItem(key), RETURN_URL_KEY)
    .catch(() => "");
  if (storedReturnUrl) {
    await page
      .evaluate((key) => sessionStorage.removeItem(key), RETURN_URL_KEY)
      .catch(() => null);
    await page.goto(storedReturnUrl, {
      waitUntil: "domcontentloaded",
    });
  } else {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
  }
  await page.waitForTimeout(500);
  if (storedReturnUrl?.includes("recommend=1")) {
    const observation = await pageObservation(page);
    if (!hasRecommendationContent(observation)) {
      const result = await feed(page);
      return {
        ...result,
        changed: true,
      };
    }
  }
  return {
    status: "ok",
    changed: page.url() !== beforeUrl,
    observation: await pageObservation(page),
  };
}

async function understandSharedContent(
  page,
  config,
  itemId,
  startSecond = null,
  endSecond = null,
  requestedSeconds = null,
) {
  const expected = cleanText(itemId, 40);
  if (!/^\d{15,22}$/u.test(expected)) {
    throw new SiteAutomationError(
      "SHARED_VIDEO_ITEM_ID_REQUIRED",
      "understand-shared requires a valid --item-id from ownerMessages.",
    );
  }
  const sourceMessage = pendingOwnerSharedItem({
    config,
    itemId: expected,
  });
  if (!sourceMessage) {
    throw new SiteAutomationError(
      "OWNER_SHARED_VIDEO_NOT_PENDING",
      "The requested video is not present in the pending owner messages.",
      { itemId: expected },
    );
  }

  const beforeUrl = page.url();
  const expectedRoute =
    sourceMessage.kind === "shared-note" ? "note" : "video";
  const targetUrl = `https://www.douyin.com/${expectedRoute}/${expected}`;
  if (!beforeUrl.includes(`/${expectedRoute}/${expected}`)) {
    await page
      .evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        { key: RETURN_URL_KEY, value: beforeUrl },
      )
      .catch(() => null);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  }
  await page
    .waitForURL(
      sourceMessage.kind === "shared-note"
        ? new RegExp(`/note/${expected}(?:[/?#]|$)`, "u")
        : new RegExp(`/(?:video|note)/${expected}(?:[/?#]|$)`, "u"),
      { timeout: 15_000 },
    )
    .catch(() => null);
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  const noteOpened =
    sourceMessage.kind === "shared-note" ||
    page.url().includes(`/note/${expected}`);
  if (noteOpened) {
    await page
      .waitForFunction(
        (expectedItemId) =>
          location.pathname.includes(`/note/${expectedItemId}`) &&
          [...document.querySelectorAll("img")].some((image) =>
            String(image.currentSrc || image.src || "").includes(
              "aweme-images",
            ),
          ),
        expected,
        { timeout: 15_000 },
      )
      .catch(() => null);
    const noteObservation = {
      ...(await pageObservation(page)),
      itemId: expected,
      pageType: "note",
      contentType: "note",
    };
    const result = await understandCurrentNote({
      page,
      observation: noteObservation,
      config,
      checkMessages: null,
    });
    return {
      ...result,
      pendingReplyRequired: true,
      sourceOwnerMessage: sourceMessage,
    };
  }
  const waitForPlayableVideo = () =>
    page
      .waitForFunction(
        (expectedItemId) =>
          location.pathname.includes(`/video/${expectedItemId}`) &&
          [...document.querySelectorAll("video")].some((video) => {
            const rect = video.getBoundingClientRect();
            const style = getComputedStyle(video);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number.isFinite(video.duration) &&
              video.duration > 0
            );
          }),
        expected,
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
  let videoReady = await waitForPlayableVideo();
  if (!videoReady) {
    await page.reload({ waitUntil: "domcontentloaded" });
    videoReady = await waitForPlayableVideo();
  }
  if (!videoReady) {
    throw new SiteAutomationError(
      "SHARED_VIDEO_NOT_READY",
      "共享视频详情页已经打开，但播放器在重载后仍未取得可播放媒体。",
      { itemId: expected },
    );
  }

  const observation = await pageObservation(page);
  if (observation.itemId !== expected) {
    throw new SiteAutomationError(
      "SHARED_VIDEO_OPEN_MISMATCH",
      "Douyin did not open the requested shared video.",
      {
        expectedItemId: expected,
        actualItemId: observation.itemId || "",
      },
    );
  }
  const result = await understandCurrentVideo({
    page,
    observation,
    config,
    checkMessages: null,
    startSecond,
    endSecond,
    requestedSeconds,
  });
  return {
    ...result,
    pendingReplyRequired: true,
    sourceOwnerMessage: sourceMessage,
  };
}

async function understandCurrentContent(
  page,
  config,
  checkMessages,
  startSecond = null,
  endSecond = null,
  requestedSeconds = null,
) {
  const observation = await pageObservation(page);
  if (observation.contentType === "note") {
    return understandCurrentNote({
      page,
      observation,
      config,
      checkMessages,
    });
  }
  return understandCurrentVideo({
    page,
    observation,
    config,
    checkMessages,
    startSecond,
    endSecond,
    requestedSeconds,
  });
}

async function runAction({ action, options, page, config }) {
  switch (action) {
    case "status":
      return observe(page);
    case "observe":
      return observeWithVision(page, config);
    case "feed":
      return feed(page);
    case "search":
      return search(page, options.keyword);
    case "open-result":
      return openSearchResult(page, options.index);
    case "next":
      return next(page);
    case "enter-live":
      return enterLive(page);
    case "exit-live":
      return exitLive(page);
    case "play":
      return play(page, options.state);
    case "like":
      return like(page, config, options.state);
    case "comment":
      return comment(page, config, options.text, options["dry-run"]);
    case "delete-comment":
      return deleteComment(page, config, options.text);
    case "read-comments":
      return readComments(page, options);
    case "profile":
      return profile(page);
    case "back":
      return back(page);
    default:
      throw new SiteAutomationError(
        "ACTION_NOT_SUPPORTED",
        `Unsupported action: ${action}`,
      );
  }
}

async function runRaw({ action, options, page, config }) {
  const feedPage = await resolveDouyinFeedPage(page, config);
  if (action === "dm-check") {
    return checkOwnerMessages({
      feedPage,
      config,
      waitMs: options["wait-ms"],
    });
  }
  if (action === "dm-reply") {
    return replyToOwner({
      feedPage,
      config,
      text: options.text,
      dryRun: options["dry-run"],
    });
  }
  if (action === "inspect-owner-image") {
    return inspectOwnerChatImage({
      feedPage,
      config,
      imageId: options["image-id"],
      question: options.question,
      dryRun: options["dry-run"],
    });
  }
  if (action === "group-reply") {
    return replyToGroup({
      feedPage,
      config,
      groupId: options["group-id"],
      text: options.text,
      dryRun: options["dry-run"],
    });
  }
  if (action === "group-request-consent") {
    return requestGroupPrivacyConsent({
      feedPage,
      config,
      groupId: options["group-id"],
      text: options.text,
      dryRun: options["dry-run"],
    });
  }
  if (action === "inspect-group-image") {
    return inspectGroupChatImage({
      feedPage,
      config,
      groupId: options["group-id"],
      imageId: options["image-id"],
      question: options.question,
      dryRun: options["dry-run"],
    });
  }
  if (action === "understand-shared") {
    return understandSharedContent(
      feedPage,
      config,
      options["item-id"],
      options["start-second"],
      options["end-second"],
      options.seconds,
    );
  }

  if (groupChatsEnabled(config)) {
    await ensureGroupMentionWatchers({ feedPage, config });
  }

  if (ownerChatEnabled(config)) {
    const before = await checkOwnerMessages({
      feedPage,
      config,
      waitMs: 0,
    });
    if (before.status === "owner-message-pending") {
      return {
        ...before,
        intendedAction: action,
        intendedActionSkipped: true,
      };
    }
  }

  const result =
    action === "group-check"
      ? await checkGroupMessages({
          feedPage,
          config,
          groupId: options["group-id"],
        })
      : action === "share-current"
      ? {
          ...(await shareCurrentWithOwner({
            feedPage,
            config,
            dryRun: options["dry-run"],
          })),
          observation: await pageObservation(feedPage),
        }
      : action === "understand-current"
        ? await understandCurrentContent(
            feedPage,
            config,
            ownerChatEnabled(config)
              ? () =>
                  checkOwnerMessages({
                    feedPage,
                    config,
                    waitMs: 0,
                  })
              : null,
            options["start-second"],
            options["end-second"],
            options.seconds,
          )
      : await runAction({ action, options, page: feedPage, config });

  let decoratedResult = result;
  if (ownerChatEnabled(config)) {
    const after = await checkOwnerMessages({
      feedPage,
      config,
      waitMs: 0,
    });
    if (after.status === "owner-message-pending") {
      return {
        ...result,
        actionResultStatus: result.status,
        ...after,
        actionCompletedBeforeOwnerMessage: true,
      };
    }
    decoratedResult = {
      ...result,
      ownerChatChecked: true,
      ownerMessages: [],
    };
  }

  // An explicit group-check has already read the configured group.  Do not
  // immediately perform a second mention-triggered group scan for the same
  // short action.
  if (action === "group-check" || !groupChatsEnabled(config)) {
    return decoratedResult;
  }
  const groupContext = await consumeConfiguredGroupMentionSignals({
    feedPage,
    config,
  });
  if (
    groupContext.groupChats.length === 0 &&
    !groupContext.privacyConsent
  ) {
    return decoratedResult;
  }
  return {
    ...decoratedResult,
    groupMentionChecked: true,
    groupChats: groupContext.groupChats,
    ...(groupContext.privacyConsent
      ? { privacyConsent: groupContext.privacyConsent }
      : {}),
  };
}

export async function run(args) {
  const startedAt = Date.now();
  const record = (value) => {
    try {
      recordDouyinAction(value);
    } catch {
      // A local audit-log failure must not change the website action result.
    }
  };
  try {
    const rawResult = await runRaw(args);
    record({
      action: args.action,
      rawResult,
      config: args.config,
      durationMs: Date.now() - startedAt,
    });
    return toAgentResult(args.action, rawResult);
  } catch (error) {
    record({
      action: args.action,
      error,
      config: args.config,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

