import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanText, SiteAutomationError } from "../../common/runtime.mjs";
import { mediaConfig, runProcess, visionCommandArgs } from "./current-media.mjs";

const ADAPTER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(ADAPTER_ROOT, "../..");
const STATE_VERSION = 1;
const WINDOW_SIZE = 24;
const GROUP_MESSAGE_LIMIT = 20;
const GROUP_MENTION_WATCHER_KEY = "__suzuLivesDouyinGroupMentionWatcherV1";
const CHAT_IMAGE_SELECTOR = "img.MessageItemImageImage";
const DEFAULT_CHAT_IMAGE_QUESTION =
  "只描述这张抖音聊天图片中直接可见的主体、动作、环境和关键文字。不要根据聊天上下文猜测；用简短中文回答。";

function asBoolean(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function asWaitMs(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.round(parsed), 120000));
}

function cleanOutgoingMessageText(value, limit = 4000) {
  const normalized = String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .split("\n")
    .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^\n+|\n+$/gu, "");
  return normalized.slice(0, limit).replace(/\n+$/gu, "");
}

function cleanEditorText(value) {
  return cleanOutgoingMessageText(value, 4000);
}

function normalizedImageId(value) {
  const imageId = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{16,64}$/iu.test(imageId) ? imageId : "";
}

function imageQuestion(value) {
  return cleanText(value, 800) || DEFAULT_CHAT_IMAGE_QUESTION;
}

// This function is executed inside the live Douyin page by Playwright.  It
// deliberately extracts only the stable media hash from the React message
// object; the source URL and the image bytes never enter the Agent result.
function messageImageReference(element) {
  const compact = (value, limit = 128) =>
    String(value || "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, limit);
  const imageIdFrom = (value) => {
    const imageId = compact(value, 128).toLowerCase();
    return /^[a-f0-9]{16,64}$/iu.test(imageId) ? imageId : "";
  };
  for (
    let domNode = element, domDepth = 0;
    domNode && domDepth < 7;
    domNode = domNode.parentElement, domDepth += 1
  ) {
    for (const reactKey of Object.keys(domNode).filter((key) =>
      /^__react(?:Fiber|Props)\$/u.test(key),
    )) {
      const visited = new Set();
      let current = domNode[reactKey];
      for (
        let fiberDepth = 0;
        current && fiberDepth < 14 && !visited.has(current);
        fiberDepth += 1
      ) {
        visited.add(current);
        const parsedCandidates = [
          current?.pendingProps?.message?.parsedContent,
          current?.memoizedProps?.message?.parsedContent,
          current?.message?.parsedContent,
          current?.pendingProps?.parsedContent,
          current?.memoizedProps?.parsedContent,
          current?.parsedContent,
        ];
        for (const parsed of parsedCandidates) {
          const resource =
            parsed?.resource_url || parsed?.resourceUrl || parsed?.resource;
          const imageId = [
            resource?.md5,
            parsed?.resource_md5,
            parsed?.resourceMd5,
            parsed?.image_md5,
            parsed?.imageMd5,
            parsed?.md5,
          ]
            .map(imageIdFrom)
            .find(Boolean);
          if (imageId) return { imageId };
        }
        current = current.return;
      }
    }
  }
  return { imageId: "" };
}

async function readMessageEditorText(editor) {
  const displayed = await editor.innerText().catch(() => null);
  return cleanEditorText(
    displayed === null ? await editor.textContent() : displayed,
  );
}

async function fillMultilineMessageEditor(editor, text) {
  await editor.fill("");
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]) await editor.type(lines[index]);
    if (index < lines.length - 1) await editor.press("Shift+Enter");
  }
}

function ownerSettings(config) {
  const raw = config?.douyin?.ownerChat || {};
  const runtimeDirectory = String(
    raw.runtimeDirectory || "runtime/douyin",
  ).trim();
  return {
    enabled: raw.enabled === true,
    displayName: cleanText(raw.displayName, 100),
    userId: cleanText(raw.userId, 100),
    messageWaitMs: asWaitMs(raw.messageWaitMs, 15000),
    runtimeDirectory: path.isAbsolute(runtimeDirectory)
      ? path.resolve(runtimeDirectory)
      : path.resolve(MODULE_ROOT, runtimeDirectory),
  };
}

function normalizedGroupId(value, index) {
  const fallback = `group-${index + 1}`;
  const compact = cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return compact || fallback;
}

function normalizedMentionNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .map((item) => cleanText(item, 80).replace(/^@+/u, ""))
        .filter(Boolean),
    ),
  ];
}

function configuredGroupSettings(config) {
  const rawGroups = Array.isArray(config?.douyin?.groupChats)
    ? config.douyin.groupChats
    : [];
  const seenIds = new Set();
  return rawGroups.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const id = normalizedGroupId(raw.id, index);
    if (seenIds.has(id)) return [];
    seenIds.add(id);
    const runtimeDirectory = String(
      raw.runtimeDirectory || "runtime/douyin/groups",
    ).trim();
    return [
      {
        id,
        enabled: raw.enabled === true,
        displayName: cleanText(raw.displayName, 100),
        mentionNames: normalizedMentionNames(raw.mentionNames),
        runtimeDirectory: path.isAbsolute(runtimeDirectory)
          ? path.resolve(runtimeDirectory)
          : path.resolve(MODULE_ROOT, runtimeDirectory),
      },
    ];
  });
}

function enabledGroupSettings(config) {
  return configuredGroupSettings(config).filter(
    (settings) => settings.enabled && settings.displayName,
  );
}

function mentionWatchGroupSettings(config) {
  return enabledGroupSettings(config).filter(
    (settings) => settings.mentionNames.length > 0,
  );
}

function requireGroupSettings(config, requestedId = "") {
  const configured = configuredGroupSettings(config);
  if (configured.length === 0) {
    throw new SiteAutomationError(
      "GROUP_CHAT_NOT_CONFIGURED",
      "douyin.groupChats must contain at least one configured group.",
    );
  }
  const enabled = configured.filter(
    (settings) => settings.enabled && settings.displayName,
  );
  if (enabled.length === 0) {
    throw new SiteAutomationError(
      "GROUP_CHAT_DISABLED",
      "No configured Douyin group chat is enabled.",
    );
  }
  const expectedId = cleanText(requestedId, 80).toLowerCase();
  if (expectedId) {
    const match = enabled.find((settings) => settings.id === expectedId);
    if (!match) {
      throw new SiteAutomationError(
        "GROUP_CHAT_NOT_FOUND",
        `No enabled Douyin group chat matches: ${expectedId}`,
      );
    }
    return match;
  }
  if (enabled.length !== 1) {
    throw new SiteAutomationError(
      "GROUP_CHAT_SELECTION_REQUIRED",
      "More than one Douyin group is enabled; pass --group-id.",
      { groupIds: enabled.map((settings) => settings.id) },
    );
  }
  return enabled[0];
}

function requireOwnerSettings(config) {
  const settings = ownerSettings(config);
  if (!settings.enabled) {
    throw new SiteAutomationError(
      "OWNER_CHAT_DISABLED",
      "Douyin owner chat is disabled in Suzu Lives' shared configuration.",
    );
  }
  if (!settings.displayName) {
    throw new SiteAutomationError(
      "OWNER_CHAT_NOT_CONFIGURED",
      "douyin.ownerChat.displayName must be configured.",
    );
  }
  return settings;
}

function statePath(settings) {
  return path.join(settings.runtimeDirectory, "private-chat-state.json");
}

function emptyState(settings) {
  return {
    version: STATE_VERSION,
    owner: {
      displayName: settings.displayName,
      userId: settings.userId,
    },
    baselineComplete: false,
    lastPreview: "",
    incomingWindow: [],
    pending: [],
    updatedAt: new Date().toISOString(),
  };
}

function readState(settings) {
  const filePath = statePath(settings);
  if (!fs.existsSync(filePath)) return emptyState(settings);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""),
    );
    if (
      parsed.version !== STATE_VERSION ||
      parsed.owner?.displayName !== settings.displayName ||
      parsed.owner?.userId !== settings.userId
    ) {
      return emptyState(settings);
    }
    return {
      ...emptyState(settings),
      ...parsed,
      baselineComplete: parsed.baselineComplete === true,
      incomingWindow: Array.isArray(parsed.incomingWindow)
        ? parsed.incomingWindow.slice(0, WINDOW_SIZE)
        : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return emptyState(settings);
  }
}

function writeState(settings, state) {
  fs.mkdirSync(settings.runtimeDirectory, { recursive: true });
  const filePath = statePath(settings);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(
      {
        ...state,
        version: STATE_VERSION,
        owner: {
          displayName: settings.displayName,
          userId: settings.userId,
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.renameSync(temporaryPath, filePath);
}

function groupStatePath(settings) {
  return path.join(settings.runtimeDirectory, `group-chat-${settings.id}.json`);
}

function emptyGroupState(settings) {
  return {
    version: STATE_VERSION,
    group: {
      id: settings.id,
      displayName: settings.displayName,
    },
    baselineComplete: false,
    lastWindowSignature: "",
    pendingPrivacyConsent: null,
    updatedAt: new Date().toISOString(),
  };
}

function pendingPrivacyConsent(value) {
  if (!value || typeof value !== "object") return null;
  const requestId = cleanText(value.requestId, 100);
  const requestText = cleanText(value.requestText, 300);
  if (!requestId || !requestText) return null;
  return {
    requestId,
    requestText,
    requestedAt: cleanText(value.requestedAt, 100),
  };
}

function readGroupState(settings) {
  const filePath = groupStatePath(settings);
  if (!fs.existsSync(filePath)) return emptyGroupState(settings);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""),
    );
    if (
      parsed.version !== STATE_VERSION ||
      parsed.group?.id !== settings.id ||
      parsed.group?.displayName !== settings.displayName
    ) {
      return emptyGroupState(settings);
    }
    return {
      ...emptyGroupState(settings),
      ...parsed,
      baselineComplete: parsed.baselineComplete === true,
      lastWindowSignature: cleanText(parsed.lastWindowSignature, 128),
      pendingPrivacyConsent: pendingPrivacyConsent(
        parsed.pendingPrivacyConsent,
      ),
    };
  } catch {
    return emptyGroupState(settings);
  }
}

function writeGroupState(settings, state) {
  fs.mkdirSync(settings.runtimeDirectory, { recursive: true });
  const filePath = groupStatePath(settings);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(
      {
        ...state,
        version: STATE_VERSION,
        group: {
          id: settings.id,
          displayName: settings.displayName,
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.renameSync(temporaryPath, filePath);
}

function consentDecisionFromOwnerReply(text, mentionNames) {
  const source = cleanText(text, 300);
  const names = mentionNames.filter(Boolean);
  if (
    names.length === 0 ||
    !names.some((name) => source.includes(`@${name}`))
  ) {
    return null;
  }
  const response = names
    .reduce((value, name) => value.replaceAll(`@${name}`, ""), source)
    .replace(/[\s,，.。!！?？:：]/gu, "");
  if (["可以", "可以说", "能说"].includes(response)) return "approved";
  if (["不可以", "不可以说", "不能说"].includes(response)) {
    return "denied";
  }
  return null;
}

function resolvePendingPrivacyConsent({
  state,
  settings,
  messages,
}) {
  const pending = state.pendingPrivacyConsent;
  if (!pending || !Array.isArray(messages)) return null;
  let requestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (cleanText(messages[index]?.text, 300) === pending.requestText) {
      requestIndex = index;
    }
  }
  if (requestIndex < 0) return null;

  for (const message of messages.slice(requestIndex + 1)) {
    if (message.speaker !== "owner-in-group") {
      continue;
    }
    const decision = consentDecisionFromOwnerReply(
      message.text,
      settings.mentionNames,
    );
    if (!decision) continue;
    state.pendingPrivacyConsent = null;
    return {
      requestId: pending.requestId,
      decision,
      source: "owner-in-group",
    };
  }
  return null;
}

function messageSignature(message) {
  return crypto
    .createHash("sha256")
    // Message identity should not change merely because the UI exposes a
    // paragraph break instead of a space. Keep the stored-window signature
    // compatible with the older compact reader while returning the original
    // paragraph structure to the Agent.
    .update(
      `${message.kind}\n${message.itemId || ""}\n${cleanText(
        message.text,
        2000,
      )}\n${message.imageId || ""}`,
    )
    .digest("hex");
}

function pendingResult(settings, state, extra = {}) {
  return {
    status: "owner-message-pending",
    browsingPaused: true,
    owner: {
      displayName: settings.displayName,
      userId: settings.userId,
    },
    ownerMessages: state.pending,
    ...extra,
  };
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function messagePane(page) {
  const dialogCandidates = page.locator(
    "[data-e2e='im-dialog'], #imSaasContainerId",
  );
  const dialogCount = await dialogCandidates.count();
  for (let index = 0; index < dialogCount; index += 1) {
    const candidate = dialogCandidates.nth(index);
    if (!(await isVisible(candidate))) continue;
    return candidate;
  }

  const candidates = page.getByRole("complementary");
  let fallback = null;
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await isVisible(candidate))) continue;
    fallback ||= candidate;
    if (
      (await candidate
        .locator(
          ".StackLayoutStackChatHeaderuser, " +
            ".conversationConversationItemtitle, " +
            "[data-e2e='conversation-item']",
        )
        .count()) > 0
    ) {
      return candidate;
    }
  }
  return fallback;
}

async function openMessagePane(page) {
  await page.bringToFront().catch(() => null);

  // Douyin first opens this panel on hover; clicking the same entry pins it.
  // Move away first so a hover-only panel is not mistaken for a pinned one.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);

  let pane = await messagePane(page);
  if (pane) return pane;

  let entry = page.locator(
    "[data-e2e='im-entry'] [data-e2e='something-button']",
  ).first();
  let entryReady = await entry
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!entryReady) {
    entry = page.getByText("消息", { exact: true }).first();
    entryReady = await entry
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!entryReady) {
    throw new SiteAutomationError(
      "MESSAGE_ENTRY_NOT_FOUND",
      "Could not find the visible Douyin message entry after the page loaded.",
    );
  }

  const box = await entry.boundingBox();
  if (!box) {
    throw new SiteAutomationError(
      "MESSAGE_ENTRY_NOT_FOUND",
      "The visible Douyin message entry had no clickable area.",
    );
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y, { steps: 8 });
  await page.waitForTimeout(250);
  await page.mouse.click(x, y);
  await page.waitForTimeout(200);
  await page.mouse.move(1, 1);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    pane = await messagePane(page);
    if (pane) return pane;
    await page.waitForTimeout(250);
  }

  throw new SiteAutomationError(
    "MESSAGE_PANE_NOT_OPENED",
    "The Douyin message entry was clicked, but the panel did not stay open.",
  );
}

async function ensureMessageWorkspace(feedPage) {
  await openMessagePane(feedPage);
  return feedPage;
}

async function returnToConversationList(page) {
  const pane = await openMessagePane(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const back = pane.locator(".StackLayoutStackTitleBarbackBtn");
    if (!(await isVisible(back))) break;
    const box = await back.boundingBox().catch(() => null);
    if (!box) {
      await page.waitForTimeout(100);
      continue;
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
  }
  return pane;
}

async function ownerConversationRow(page, settings) {
  const pane = await returnToConversationList(page);
  const titles = pane.locator(".conversationConversationItemtitle");
  const matches = [];
  const count = await titles.count();
  for (let index = 0; index < count; index += 1) {
    const title = titles.nth(index);
    if (!(await isVisible(title))) continue;
    if (cleanText(await title.innerText(), 100) === settings.displayName) {
      matches.push(
        title.locator(
          "xpath=ancestor::*[@data-e2e='conversation-item'][1]",
        ),
      );
    }
  }
  if (matches.length === 0) {
    throw new SiteAutomationError(
      "OWNER_CONVERSATION_NOT_FOUND",
      `Could not find the configured Douyin conversation: ${settings.displayName}`,
    );
  }
  if (matches.length > 1) {
    throw new SiteAutomationError(
      "OWNER_CONVERSATION_AMBIGUOUS",
      `More than one Douyin conversation exactly matches: ${settings.displayName}`,
      { count: matches.length },
    );
  }
  return matches[0];
}

async function groupConversationRow(page, settings) {
  const pane = await returnToConversationList(page);
  const titles = pane.locator(".conversationConversationItemtitle");
  const matches = [];
  const count = await titles.count();
  for (let index = 0; index < count; index += 1) {
    const title = titles.nth(index);
    if (!(await isVisible(title))) continue;
    if (cleanText(await title.innerText(), 100) === settings.displayName) {
      matches.push(
        title.locator(
          "xpath=ancestor::*[@data-e2e='conversation-item'][1]",
        ),
      );
    }
  }
  if (matches.length === 0) {
    throw new SiteAutomationError(
      "GROUP_CONVERSATION_NOT_FOUND",
      `Could not find the configured Douyin group: ${settings.displayName}`,
    );
  }
  if (matches.length > 1) {
    throw new SiteAutomationError(
      "GROUP_CONVERSATION_AMBIGUOUS",
      `More than one Douyin conversation exactly matches group: ${settings.displayName}`,
      { count: matches.length },
    );
  }
  return matches[0];
}

async function conversationSnapshot(row) {
  return row.evaluate((element) => {
    const text = (selector) =>
      (element.querySelector(selector)?.textContent || "")
        .replace(/\s+/gu, " ")
        .trim();
    const markerElements = [...element.querySelectorAll("*")].filter(
      (candidate) => {
        const className = String(candidate.className || "");
        if (
          !/(unread|badge|notice|messageCount|unreadCount|countBadge|badgeCount)/iu.test(
            className,
          )
        ) {
          return false;
        }
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      },
    );
    const markerTexts = markerElements
      .map((candidate) => (candidate.textContent || "").trim())
      .filter(Boolean);
    const counts = markerTexts
      .flatMap((value) => value.match(/\d+/gu) || [])
      .map(Number)
      .filter((value) => Number.isFinite(value));
    return {
      title: text(".conversationConversationItemtitle"),
      preview: text(".ConversationItemHinttextBox"),
      time: text(".ConversationItemTagNextToTitletimeStr"),
      unread: markerElements.length > 0,
      unreadCount: counts.length > 0 ? Math.max(...counts) : 0,
    };
  });
}

async function clearGroupMentionSignals(feedPage, groupIds) {
  const ids = [...new Set(groupIds.filter(Boolean))];
  if (ids.length === 0) return;
  await feedPage
    .evaluate(
      ({ key, ids: expectedIds }) => {
        const state = window[key];
        if (!state?.pending) return;
        for (const id of expectedIds) delete state.pending[id];
      },
      { key: GROUP_MENTION_WATCHER_KEY, ids },
    )
    .catch(() => null);
}

export async function ensureGroupMentionWatchers({ feedPage, config }) {
  const groups = mentionWatchGroupSettings(config).map((settings) => ({
    id: settings.id,
    displayName: settings.displayName,
    mentionNames: settings.mentionNames,
  }));
  if (groups.length === 0) return;

  await returnToConversationList(feedPage);
  await feedPage.evaluate(
    ({ key, watchedGroups }) => {
      const compact = (value) =>
        String(value || "").replace(/\s+/gu, " ").trim();
      const state = window[key] || {
        groups: {},
        pending: {},
        observer: null,
        scheduled: false,
      };

      const activeIds = new Set(watchedGroups.map((group) => group.id));
      for (const id of Object.keys(state.groups)) {
        if (!activeIds.has(id)) delete state.groups[id];
      }
      for (const group of watchedGroups) {
        state.groups[group.id] = {
          ...(state.groups[group.id] || {}),
          ...group,
        };
      }

      const scan = () => {
        const rows = [
          ...document.querySelectorAll("[data-e2e='conversation-item']"),
        ];
        for (const group of Object.values(state.groups)) {
          const row = rows.find(
            (candidate) =>
              compact(
                candidate.querySelector(
                  ".conversationConversationItemtitle",
                )?.innerText,
              ) === group.displayName,
          );
          if (!row) continue;
          const preview = compact(
            row.querySelector(".ConversationItemHinttextBox")?.innerText,
          );
          const time = compact(
            row.querySelector(".ConversationItemTagNextToTitletimeStr")?.innerText,
          );
          const signature = `${preview}\n${time}`;
          if (!signature || signature === group.lastSignature) continue;
          group.lastSignature = signature;
          const mentionName = group.mentionNames.find((name) =>
            preview.includes(`@${name}`),
          );
          if (mentionName) {
            state.pending[group.id] = {
              mentionName,
              observedAt: new Date().toISOString(),
            };
          }
        }
      };

      if (!state.observer) {
        state.observer = new MutationObserver(() => {
          if (state.scheduled) return;
          state.scheduled = true;
          queueMicrotask(() => {
            state.scheduled = false;
            scan();
          });
        });
        state.observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
      window[key] = state;
      scan();
    },
    { key: GROUP_MENTION_WATCHER_KEY, watchedGroups: groups },
  );
}

export async function consumeConfiguredGroupMentionSignals({ feedPage, config }) {
  const groups = mentionWatchGroupSettings(config);
  if (groups.length === 0) {
    return { status: "ok", groupMentionChecked: false, groupChats: [] };
  }
  const pendingIds = await feedPage
    .evaluate(
      ({ key, ids }) => {
        const pending = window[key]?.pending || {};
        const found = ids.filter((id) => Boolean(pending[id]));
        for (const id of found) delete pending[id];
        return found;
      },
      { key: GROUP_MENTION_WATCHER_KEY, ids: groups.map((group) => group.id) },
    )
    .catch(() => []);
  if (pendingIds.length === 0) {
    return { status: "ok", groupMentionChecked: true, groupChats: [] };
  }

  const pendingSet = new Set(pendingIds);
  const groupChats = [];
  const owner = ownerSettings(config);
  let privacyConsent = null;
  for (const settings of groups) {
    if (!pendingSet.has(settings.id)) continue;
    const result = await checkOneGroupMessages({
      feedPage,
      settings,
      ownerDisplayName: owner.displayName,
      ownerUserId: owner.userId,
      force: true,
    });
    if (result.groupChat) {
      groupChats.push({ ...result.groupChat, trigger: "mention" });
    }
    privacyConsent ||= result.privacyConsent || null;
  }
  return {
    status: groupChats.length > 0 ? "group-chat-context" : "ok",
    groupMentionChecked: true,
    groupChats,
    ...(privacyConsent ? { privacyConsent } : {}),
  };
}

async function openOwnerConversation(page, settings) {
  const row = await ownerConversationRow(page, settings);
  const snapshot = await conversationSnapshot(row);
  await row.click();
  const pane = await openMessagePane(page);
  const header = pane.locator(".StackLayoutStackChatHeadertitle");
  await header.waitFor({ state: "visible", timeout: 5000 });
  const actualTitle = cleanText(await header.innerText(), 100);
  if (actualTitle !== settings.displayName) {
    throw new SiteAutomationError(
      "OWNER_CONVERSATION_MISMATCH",
      `Opened "${actualTitle}" instead of "${settings.displayName}".`,
    );
  }
  return { pane, snapshot };
}

async function openGroupConversation(page, settings) {
  const row = await groupConversationRow(page, settings);
  const snapshot = await conversationSnapshot(row);
  await row.click();
  const pane = await openMessagePane(page);
  const header = pane.locator(".StackLayoutStackChatHeadertitle");
  await header.waitFor({ state: "visible", timeout: 5000 });
  const actualTitle = cleanText(await header.innerText(), 100);
  if (!matchesGroupHeader(actualTitle, settings.displayName)) {
    throw new SiteAutomationError(
      "GROUP_CONVERSATION_MISMATCH",
      `Opened "${actualTitle}" instead of group "${settings.displayName}".`,
    );
  }
  return { pane, snapshot };
}

async function incomingMessages(pane) {
  return pane.evaluate((root) => {
    const compact = (value, limit = 2000) =>
      String(value || "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, limit);
    const preserveParagraphs = (value, limit = 2000) =>
      String(value || "")
        .replace(/\r\n?/gu, "\n")
        .replace(/[\u200B-\u200D\uFEFF]/gu, "")
        .split("\n")
        .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .replace(/^\n+|\n+$/gu, "")
        .slice(0, limit);
    const sharedContentMetadata = (element) => {
      for (
        let domNode = element, domDepth = 0;
        domNode && domDepth < 5;
        domNode = domNode.parentElement, domDepth += 1
      ) {
        for (const reactKey of Object.keys(domNode).filter((key) =>
          /^__react(?:Fiber|Props)\$/u.test(key),
        )) {
          let current = domNode[reactKey];
          for (let fiberDepth = 0; current && fiberDepth < 10; fiberDepth += 1) {
            const parsedCandidates = [
              current?.pendingProps?.message?.parsedContent,
              current?.memoizedProps?.message?.parsedContent,
              current?.message?.parsedContent,
              current?.parsedContent,
            ];
            for (const parsed of parsedCandidates) {
              const itemId = compact(parsed?.itemId, 40);
              if (!/^\d{15,22}$/u.test(itemId)) continue;
              const awemeType = Number(
                parsed?.awemeType ?? parsed?.aweme_type,
              );
              const isSlides =
                parsed?.is_slides === true ||
                ["1", "true"].includes(
                  String(parsed?.is_slides || "").toLowerCase(),
                );
              return {
                itemId,
                isSlides,
                awemeType: Number.isFinite(awemeType) ? awemeType : null,
              };
            }
            current = current.return;
          }
        }
      }
      return { itemId: "", isSlides: false, awemeType: null };
    };
    const imageReference = (element) => {
      const imageIdFrom = (value) => {
        const imageId = compact(value, 128).toLowerCase();
        return /^[a-f0-9]{16,64}$/iu.test(imageId) ? imageId : "";
      };
      for (
        let domNode = element, domDepth = 0;
        domNode && domDepth < 7;
        domNode = domNode.parentElement, domDepth += 1
      ) {
        for (const reactKey of Object.keys(domNode).filter((key) =>
          /^__react(?:Fiber|Props)\$/u.test(key),
        )) {
          const visited = new Set();
          let current = domNode[reactKey];
          for (
            let fiberDepth = 0;
            current && fiberDepth < 14 && !visited.has(current);
            fiberDepth += 1
          ) {
            visited.add(current);
            const parsedCandidates = [
              current?.pendingProps?.message?.parsedContent,
              current?.memoizedProps?.message?.parsedContent,
              current?.message?.parsedContent,
              current?.pendingProps?.parsedContent,
              current?.memoizedProps?.parsedContent,
              current?.parsedContent,
            ];
            for (const parsed of parsedCandidates) {
              const resource =
                parsed?.resource_url || parsed?.resourceUrl || parsed?.resource;
              const imageId = [
                resource?.md5,
                parsed?.resource_md5,
                parsed?.resourceMd5,
                parsed?.image_md5,
                parsed?.imageMd5,
                parsed?.md5,
              ]
                .map(imageIdFrom)
                .find(Boolean);
              if (imageId) return { imageId };
            }
            current = current.return;
          }
        }
      }
      return { imageId: "" };
    };
    const results = [];
    for (const item of root.querySelectorAll(
      "[data-e2e='msg-item-content']",
    )) {
      let cursor = item;
      let fromMe = false;
      for (let depth = 0; cursor && depth < 6; depth += 1) {
        if (/isFromMe/u.test(String(cursor.className || ""))) {
          fromMe = true;
          break;
        }
        cursor = cursor.parentElement;
      }
      if (fromMe) continue;

      const textBubble = item.querySelector(
        ".MessageItemTextbubbleTextContent",
      );
      const text = preserveParagraphs(
        textBubble?.innerText || textBubble?.textContent,
      );
      if (text) {
        results.push({ kind: "text", text });
        continue;
      }

      const video = item.querySelector(".MessageItemShareAwemecontainer");
      if (video) {
        const author = compact(
          video.querySelector(".MessageItemShareAwemeauthorName")
            ?.textContent,
          300,
        );
        const metadata = sharedContentMetadata(video);
        const isNote = metadata.isSlides || metadata.awemeType === 68;
        results.push({
          kind: isNote ? "shared-note" : "shared-video",
          text: author
            ? `分享了${isNote ? "图文" : "视频"}（作者：${author}）`
            : `分享了一个${isNote ? "图文" : "视频"}`,
          ...(metadata.itemId ? { itemId: metadata.itemId } : {}),
        });
        continue;
      }

      const image = item.querySelector("img.MessageItemImageImage");
      if (image) {
        const reference = imageReference(image);
        results.push({
          kind: "image",
          text: "发送了一张图片",
          ...(reference.imageId ? { imageId: reference.imageId } : {}),
        });
        continue;
      }

      const fallback = compact(item.innerText, 500);
      if (fallback) results.push({ kind: "other", text: fallback });
    }
    return results.slice(0, 60);
  });
}

async function latestGroupMessages(
  pane,
  { ownerDisplayName = "", ownerUserId = "" } = {},
) {
  const ownerName = cleanText(ownerDisplayName, 80);
  const ownerId = cleanText(ownerUserId, 100);
  const messages = await pane.evaluate((root, limit) => {
    const compact = (value, maximum = 2000) =>
      String(value || "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum);
    const preserveParagraphs = (value, maximum = 2000) =>
      String(value || "")
        .replace(/\r\n?/gu, "\n")
        .replace(/[\u200B-\u200D\uFEFF]/gu, "")
        .split("\n")
        .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .replace(/^\n+|\n+$/gu, "")
        .slice(0, maximum);
    const isFromMe = (item) => {
      for (let cursor = item, depth = 0; cursor && depth < 7; cursor = cursor.parentElement, depth += 1) {
        if (/isFromMe/u.test(String(cursor.className || ""))) return true;
      }
      return false;
    };
    const senderUserId = (item) => {
      for (
        let domNode = item, domDepth = 0;
        domNode && domDepth < 6;
        domNode = domNode.parentElement, domDepth += 1
      ) {
        for (const reactKey of Object.keys(domNode).filter((key) =>
          /^__react(?:Fiber|Props)\$/u.test(key),
        )) {
          const queue = [domNode[reactKey]];
          const visited = new Set();
          while (queue.length > 0 && visited.size < 80) {
            const current = queue.shift();
            if (!current || typeof current !== "object" || visited.has(current)) {
              continue;
            }
            visited.add(current);
            const uid = compact(
              current?.pendingProps?.uid ?? current?.memoizedProps?.uid,
              100,
            );
            if (uid) return uid;
            if (current.child) queue.push(current.child);
          }
        }
      }
      return "";
    };
    const senderLabel = (item, fromMe, content) => {
      if (fromMe) return "Agent";
      for (let scope = item, depth = 0; scope && depth < 6; scope = scope.parentElement, depth += 1) {
        if (!/MessageBoxContentcolumnBox/u.test(String(scope.className || ""))) {
          continue;
        }
        const surrounding = compact(scope.innerText, 300);
        const prefix = content && surrounding.endsWith(content)
          ? surrounding.slice(0, -content.length).trim()
          : surrounding;
        if (prefix && prefix.length <= 80) return prefix;
      }
      const candidates = [];
      for (let scope = item, depth = 0; scope && depth < 5; scope = scope.parentElement, depth += 1) {
        for (const element of scope.querySelectorAll("[data-e2e], [class]")) {
          const marker = `${element.getAttribute("data-e2e") || ""} ${String(element.className || "")}`;
          if (!/(sender|nickname|nick.?name|user.?name|author)/iu.test(marker)) continue;
          const value = compact(element.textContent, 80);
          if (
            value &&
            value.length <= 80 &&
            !/(发送|图片|视频|分享|复制|撤回|删除)/u.test(value)
          ) {
            candidates.push(value);
          }
        }
      }
      return candidates[0] || "昵称未显示";
    };
    const imageReference = (element) => {
      const imageIdFrom = (value) => {
        const imageId = compact(value, 128).toLowerCase();
        return /^[a-f0-9]{16,64}$/iu.test(imageId) ? imageId : "";
      };
      for (
        let domNode = element, domDepth = 0;
        domNode && domDepth < 7;
        domNode = domNode.parentElement, domDepth += 1
      ) {
        for (const reactKey of Object.keys(domNode).filter((key) =>
          /^__react(?:Fiber|Props)\$/u.test(key),
        )) {
          const visited = new Set();
          let current = domNode[reactKey];
          for (
            let fiberDepth = 0;
            current && fiberDepth < 14 && !visited.has(current);
            fiberDepth += 1
          ) {
            visited.add(current);
            const parsedCandidates = [
              current?.pendingProps?.message?.parsedContent,
              current?.memoizedProps?.message?.parsedContent,
              current?.message?.parsedContent,
              current?.pendingProps?.parsedContent,
              current?.memoizedProps?.parsedContent,
              current?.parsedContent,
            ];
            for (const parsed of parsedCandidates) {
              const resource =
                parsed?.resource_url || parsed?.resourceUrl || parsed?.resource;
              const imageId = [
                resource?.md5,
                parsed?.resource_md5,
                parsed?.resourceMd5,
                parsed?.image_md5,
                parsed?.imageMd5,
                parsed?.md5,
              ]
                .map(imageIdFrom)
                .find(Boolean);
              if (imageId) return { imageId };
            }
            current = current.return;
          }
        }
      }
      return { imageId: "" };
    };
    const results = [];
    let order = 0;
    for (const item of root.querySelectorAll("[data-e2e='msg-item-content']")) {
      const fromMe = isFromMe(item);
      const textBubble = item.querySelector(
        ".MessageItemTextbubbleTextContent",
      );
      const text = preserveParagraphs(
        textBubble?.innerText || textBubble?.textContent,
      );
      let kind = "text";
      let content = text;
      if (!content && item.querySelector(".MessageItemShareAwemecontainer")) {
        const author = compact(
          item.querySelector(".MessageItemShareAwemeauthorName")?.textContent,
          300,
        );
        kind = "shared-content";
        content = author ? `分享了内容（作者：${author}）` : "分享了内容";
      }
      const image = item.querySelector("img.MessageItemImageImage");
      let imageId = "";
      if (!content && image) {
        kind = "image";
        content = "发送了一张图片";
        imageId = imageReference(image).imageId;
      }
      if (!content) {
        kind = "other";
        content = compact(item.innerText, 500);
      }
      if (!content) continue;
      const sender = senderLabel(item, fromMe, content);
      const senderId = fromMe ? "" : senderUserId(item);
      const rect = item.getBoundingClientRect();
      results.push({
        kind,
        text: content,
        ...(imageId ? { imageId } : {}),
        sender,
        senderId,
        speaker: fromMe ? "agent" : "group-member",
        top: Number.isFinite(rect.top) ? rect.top : 0,
        order: order += 1,
      });
    }
    const ordered = results.sort(
      (left, right) => left.top - right.top || left.order - right.order,
    );
    let previousSender = "";
    for (const message of ordered) {
      if (message.sender === "昵称未显示" && previousSender) {
        // Douyin omits the nickname for a consecutive message from the same person.
        message.sender = previousSender;
      } else if (message.sender !== "昵称未显示") {
        previousSender = message.sender;
      }
    }
    return ordered
      .slice(-limit)
      .map(({ top, order, ...message }) => message);
  }, GROUP_MESSAGE_LIMIT);
  return messages.map(({ senderId, ...message }) => ({
    ...message,
    speaker:
      message.speaker === "agent"
        ? "agent"
        : ownerId
          ? senderId === ownerId
            ? "owner-in-group"
            : "group-member"
          : ownerName && message.sender === ownerName
            ? "owner-in-group"
            : "group-member",
  }));
}

function groupWindowSignature(messages) {
  return crypto
    .createHash("sha256")
    .update(
      messages
        .map((message) =>
          [
            message.speaker,
            message.sender,
            message.kind,
            message.imageId || "",
            cleanText(message.text, 2000),
          ].join("\n"),
        )
        .join("\n\n"),
    )
    .digest("hex");
}

function groupChatContext(settings, messages) {
  return {
    id: settings.id,
    displayName: settings.displayName,
    conversationType: "group",
    messageLimit: GROUP_MESSAGE_LIMIT,
    commandAuthority: "none",
    capturedAt: new Date().toISOString(),
    messages,
  };
}

function matchesGroupHeader(actualTitle, displayName) {
  if (actualTitle === displayName) return true;
  if (!actualTitle.startsWith(displayName)) return false;
  return /^\s*[（(]\d+[）)]\s*$/u.test(
    actualTitle.slice(displayName.length),
  );
}

function applyNewestSharePreview(messages, preview) {
  const newest = messages[0];
  if (!newest?.itemId || !newest.kind?.startsWith("shared-")) {
    return messages;
  }
  if (/分享\[图集\]/u.test(preview)) {
    newest.kind = "shared-note";
    newest.text = newest.text.replace(/分享了(?:一个)?视频/u, (matched) =>
      matched.includes("一个") ? "分享了一个图文" : "分享了图文",
    );
  } else if (/分享\[视频\]/u.test(preview)) {
    newest.kind = "shared-video";
    newest.text = newest.text.replace(/分享了(?:一个)?图文/u, (matched) =>
      matched.includes("一个") ? "分享了一个视频" : "分享了视频",
    );
  }
  return messages;
}

function findPreviousWindow(currentSignatures, previousWindow) {
  if (previousWindow.length === 0) return -1;
  const limit = currentSignatures.length - previousWindow.length;
  for (let start = 0; start <= limit; start += 1) {
    let matches = true;
    for (let offset = 0; offset < previousWindow.length; offset += 1) {
      if (currentSignatures[start + offset] !== previousWindow[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function mergeCapturedMessages(state, current, unreadCount, shouldCapture) {
  const signatures = current.map(messageSignature);
  const previousWindow = state.incomingWindow || [];
  let newest = [];

  if (shouldCapture) {
    // A conversation-list unread badge can linger briefly after an outgoing
    // reply. Compare the actual message window first, otherwise that stale
    // badge can enqueue an already answered owner message a second time.
    const previousStart = findPreviousWindow(signatures, previousWindow);
    if (previousStart > 0) {
      newest = current.slice(0, previousStart);
    } else if (previousStart < 0 && unreadCount > 0) {
      newest = current.slice(0, unreadCount);
    } else if (previousStart < 0 && current.length > 0) {
      newest = current.slice(0, 1);
    }
  }

  const capturedAt = new Date().toISOString();
  const additions = newest
    .slice()
    .reverse()
    .map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      capturedAt,
    }));
  state.incomingWindow = signatures.slice(0, WINDOW_SIZE);
  state.pending.push(...additions);
  return additions;
}

async function refreshFromList(feedPage, settings, state) {
  const workspacePage = await ensureMessageWorkspace(feedPage);
  try {
    const row = await ownerConversationRow(workspacePage, settings);
    const snapshot = await conversationSnapshot(row);
    const initialized = state.baselineComplete === true;
    const changed = initialized && snapshot.preview !== state.lastPreview;
    const shouldOpen = snapshot.unread || changed;

    if (!initialized && !snapshot.unread) {
      const opened = await openOwnerConversation(workspacePage, settings);
      const current = applyNewestSharePreview(
        await incomingMessages(opened.pane),
        snapshot.preview,
      );
      mergeCapturedMessages(state, current, 0, false);
      state.baselineComplete = true;
      await returnToConversationList(workspacePage);
      const updatedRow = await ownerConversationRow(workspacePage, settings);
      state.lastPreview = (await conversationSnapshot(updatedRow)).preview;
      writeState(settings, state);
      return { additions: [], snapshot };
    }
    if (!shouldOpen) return { additions: [], snapshot };

    const opened = await openOwnerConversation(workspacePage, settings);
    const current = applyNewestSharePreview(
      await incomingMessages(opened.pane),
      snapshot.preview,
    );
    const additions = mergeCapturedMessages(
      state,
      current,
      snapshot.unreadCount,
      true,
    );
    state.baselineComplete = true;
    await returnToConversationList(workspacePage);
    const updatedRow = await ownerConversationRow(workspacePage, settings);
    state.lastPreview = (await conversationSnapshot(updatedRow)).preview;
    writeState(settings, state);
    return { additions, snapshot };
  } finally {
    await returnToConversationList(workspacePage).catch(() => null);
    await feedPage.bringToFront().catch(() => null);
  }
}

export function ownerChatEnabled(config) {
  return ownerSettings(config).enabled;
}

export function groupChatsEnabled(config) {
  return enabledGroupSettings(config).length > 0;
}

async function checkOneGroupMessages({
  feedPage,
  settings,
  ownerDisplayName,
  ownerUserId,
  force = false,
}) {
  const state = readGroupState(settings);
  const workspacePage = await ensureMessageWorkspace(feedPage);
  try {
    const { pane } = await openGroupConversation(workspacePage, settings);
    const messages = await latestGroupMessages(pane, {
      ownerDisplayName,
      ownerUserId,
    });
    const signature = groupWindowSignature(messages);
    const privacyConsent = resolvePendingPrivacyConsent({
      state,
      settings,
      messages,
    });
    const changed =
      messages.length > 0 &&
      (force || !state.baselineComplete || signature !== state.lastWindowSignature);
    state.baselineComplete = true;
    state.lastWindowSignature = signature;
    writeGroupState(settings, state);
    return {
      status: changed ? "group-chat-context" : "ok",
      groupChatChecked: true,
      ...(changed ? { groupChat: groupChatContext(settings, messages) } : {}),
      ...(privacyConsent ? { privacyConsent } : {}),
    };
  } finally {
    await returnToConversationList(workspacePage).catch(() => null);
    await feedPage.bringToFront().catch(() => null);
  }
}

export async function checkGroupMessages({
  feedPage,
  config,
  groupId = "",
}) {
  const settings = requireGroupSettings(config, groupId);
  const owner = ownerSettings(config);
  const result = await checkOneGroupMessages({
    feedPage,
    settings,
    ownerDisplayName: owner.displayName,
    ownerUserId: owner.userId,
    force: true,
  });
  await clearGroupMentionSignals(feedPage, [settings.id]);
  return {
    status: result.status,
    groupChatsChecked: true,
    groupChats: result.groupChat ? [result.groupChat] : [],
    ...(result.privacyConsent ? { privacyConsent: result.privacyConsent } : {}),
  };
}

async function findChatImage(pane, imageId, { messageLimit = 0 } = {}) {
  const expectedImageId = normalizedImageId(imageId);
  if (!expectedImageId) {
    throw new SiteAutomationError(
      "IMAGE_REFERENCE_REQUIRED",
      "A valid image-id returned by dm-check or group-check is required.",
    );
  }

  const messageItems = pane.locator("[data-e2e='msg-item-content']");
  const itemCount = await messageItems.count();
  const start =
    messageLimit > 0 ? Math.max(0, itemCount - messageLimit) : 0;
  for (let itemIndex = start; itemIndex < itemCount; itemIndex += 1) {
    const images = messageItems.nth(itemIndex).locator(CHAT_IMAGE_SELECTOR);
    const imageCount = await images.count();
    for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
      const candidate = images.nth(imageIndex);
      if (!(await isVisible(candidate))) continue;
      const reference = await candidate
        .evaluate(messageImageReference)
        .catch(() => null);
      if (normalizedImageId(reference?.imageId) === expectedImageId) {
        return candidate;
      }
    }
  }

  throw new SiteAutomationError(
    "CHAT_IMAGE_NOT_FOUND",
    "The referenced image is not available in this conversation's allowed message window.",
  );
}

async function inspectChatImage({
  image,
  imageId,
  config,
  source,
  question = "",
  dryRun = false,
}) {
  const settings = mediaConfig(config);
  if (!settings.visionEnabled) {
    throw new SiteAutomationError(
      "CHAT_IMAGE_VISION_DISABLED",
      "Douyin chat-image understanding is disabled by douyin.media.visionEnabled.",
    );
  }
  const normalizedId = normalizedImageId(imageId);
  const screenshotDirectory = path.join(settings.runtimeRoot, "chat-images");
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const screenshotPath = path.join(
    screenshotDirectory,
    `${normalizedId}-${Date.now()}.png`,
  );
  const isDryRun = asBoolean(dryRun);

  try {
    await image.screenshot({ path: screenshotPath, type: "png" });
    if (isDryRun) {
      return {
        status: "validated",
        dryRun: true,
        conversationType: source === "group-chat" ? "group" : "direct",
        image: {
          imageId: normalizedId,
          source,
          status: "validated",
        },
      };
    }

    let result;
    try {
      result = await runProcess(
        settings.suzuLivesCommand,
        visionCommandArgs(settings, screenshotPath, imageQuestion(question)),
        { timeoutMs: settings.processTimeoutMs },
      );
    } catch {
      throw new SiteAutomationError(
        "CHAT_IMAGE_VISION_FAILED",
        "The configured vision service could not understand this chat image.",
      );
    }
    const summary = String(result.stdout || "").trim();
    if (!summary) {
      throw new SiteAutomationError(
        "CHAT_IMAGE_VISION_EMPTY",
        "The configured vision service returned no description for this chat image.",
      );
    }
    return {
      status: "ok",
      conversationType: source === "group-chat" ? "group" : "direct",
      image: {
        imageId: normalizedId,
        source,
        summary,
      },
    };
  } catch (error) {
    if (error instanceof SiteAutomationError) throw error;
    throw new SiteAutomationError(
      "CHAT_IMAGE_CAPTURE_FAILED",
      "Could not capture the referenced chat image for visual understanding.",
    );
  } finally {
    if (isDryRun || !settings.keepScreenshots) {
      fs.rmSync(screenshotPath, { force: true });
    }
  }
}

export async function inspectOwnerChatImage({
  feedPage,
  config,
  imageId,
  question = "",
  dryRun = false,
}) {
  const settings = requireOwnerSettings(config);
  const expectedImageId = normalizedImageId(imageId);
  const state = readState(settings);
  const isPendingImage = state.pending.some(
    (message) =>
      message.kind === "image" &&
      normalizedImageId(message.imageId) === expectedImageId,
  );
  if (!isPendingImage) {
    throw new SiteAutomationError(
      "OWNER_IMAGE_NOT_PENDING",
      "The image-id is not one of the current pending owner messages.",
    );
  }

  const workspacePage = await ensureMessageWorkspace(feedPage);
  try {
    const { pane } = await openOwnerConversation(workspacePage, settings);
    const image = await findChatImage(pane, expectedImageId);
    return inspectChatImage({
      image,
      imageId: expectedImageId,
      config,
      source: "owner-chat",
      question,
      dryRun,
    });
  } finally {
    await returnToConversationList(workspacePage).catch(() => null);
    await feedPage.bringToFront().catch(() => null);
  }
}

export async function inspectGroupChatImage({
  feedPage,
  config,
  groupId = "",
  imageId,
  question = "",
  dryRun = false,
}) {
  const settings = requireGroupSettings(config, groupId);
  const workspacePage = await ensureMessageWorkspace(feedPage);
  try {
    const { pane } = await openGroupConversation(workspacePage, settings);
    const image = await findChatImage(pane, imageId, {
      messageLimit: GROUP_MESSAGE_LIMIT,
    });
    return inspectChatImage({
      image,
      imageId,
      config,
      source: "group-chat",
      question,
      dryRun,
    });
  } finally {
    await returnToConversationList(workspacePage).catch(() => null);
    await feedPage.bringToFront().catch(() => null);
  }
}

export function pendingOwnerSharedItem({ config, itemId }) {
  const settings = requireOwnerSettings(config);
  const expected = cleanText(itemId, 40);
  if (!/^\d{15,22}$/u.test(expected)) return null;
  const state = readState(settings);
  return (
    state.pending.find(
      (message) =>
        ["shared-video", "shared-note"].includes(message.kind) &&
        message.itemId === expected,
    ) || null
  );
}

export async function resolveDouyinFeedPage(candidatePage, config) {
  const pages = candidatePage
    .context()
    .pages()
    .filter(
      (page) => !page.isClosed() && page.url().includes("douyin.com"),
    );
  let feedPage = null;
  for (const page of pages) {
    if (
      await page
        .locator("[data-e2e='feed-active-video']")
        .isVisible()
        .catch(() => false)
    ) {
      feedPage = page;
      break;
    }
  }
  feedPage ||= pages[0] || candidatePage;
  await feedPage.bringToFront().catch(() => null);
  if (ownerSettings(config).enabled || groupChatsEnabled(config)) {
    await openMessagePane(feedPage);
  }
  return feedPage;
}

export async function checkOwnerMessages({
  feedPage,
  config,
  waitMs = 0,
}) {
  const settings = requireOwnerSettings(config);
  const state = readState(settings);
  if (state.pending.length > 0) return pendingResult(settings, state);

  const deadline = Date.now() + asWaitMs(waitMs, 0);
  do {
    await refreshFromList(feedPage, settings, state);
    if (state.pending.length > 0) return pendingResult(settings, state);
    if (Date.now() >= deadline) break;
    await feedPage.waitForTimeout(Math.min(500, deadline - Date.now()));
  } while (Date.now() < deadline);

  return {
    status: "ok",
    ownerChatChecked: true,
    ownerMessages: [],
  };
}

async function exactOutgoingCount(pane, text) {
  return pane.evaluate((root, expected) => {
    return [...root.querySelectorAll(".MessageItemTextcontainer")]
      .filter((item) => item.classList.contains("MessageItemTextisFromMe"))
      .filter(
        (item) =>
          (item.querySelector(".MessageItemTextbubbleTextContent")
            ?.textContent || "")
            .replace(/\s+/gu, " ")
            .trim() === expected,
      ).length;
  }, cleanText(text, 4000));
}

async function clearMessageEditor(page, editor) {
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(150);
  await editor.evaluate((element) => element.blur());
  await page.waitForTimeout(250);
  if (cleanEditorText(await editor.textContent()) !== "") {
    await editor.fill("");
    await editor.evaluate((element) => element.blur());
    await page.waitForTimeout(250);
  }
  if (cleanEditorText(await editor.textContent()) !== "") {
    throw new SiteAutomationError(
      "MESSAGE_DRAFT_CLEANUP_FAILED",
      "The Douyin private-message dry run could not clear its draft.",
    );
  }
}

export async function replyToOwner({
  feedPage,
  config,
  text,
  dryRun = false,
}) {
  const settings = requireOwnerSettings(config);
  // Keep intentional paragraph breaks in a single private-message bubble.
  // This deliberately does not invent new paragraphs or split one reply into
  // several messages.
  const reply = cleanOutgoingMessageText(text, 4000);
  if (!reply) {
    throw new SiteAutomationError(
      "MESSAGE_TEXT_REQUIRED",
      "dm-reply requires non-empty --text.",
    );
  }

  const state = readState(settings);
  const pendingBefore = state.pending.length;
  const workspacePage = await ensureMessageWorkspace(feedPage);
  try {
    const { pane, snapshot } = await openOwnerConversation(
      workspacePage,
      settings,
    );
    const current = applyNewestSharePreview(
      await incomingMessages(pane),
      snapshot.preview,
    );
    const additions = mergeCapturedMessages(
      state,
      current,
      snapshot.unreadCount,
      snapshot.unread || snapshot.preview !== state.lastPreview,
    );
    state.baselineComplete = true;
    if (additions.length > 0) {
      writeState(settings, state);
      await returnToConversationList(workspacePage);
      return pendingResult(settings, state, {
        replySent: false,
        reason: "new-owner-message-before-reply",
      });
    }

    const editors = pane.locator("div[contenteditable='true']");
    let editor = null;
    const editorCount = await editors.count();
    for (let index = 0; index < editorCount; index += 1) {
      const candidate = editors.nth(index);
      if (await isVisible(candidate)) {
        editor = candidate;
        break;
      }
    }
    if (!editor) {
      throw new SiteAutomationError(
        "MESSAGE_EDITOR_NOT_FOUND",
        "Could not find the visible Douyin private-message editor.",
      );
    }

    await fillMultilineMessageEditor(editor, reply);
    const entered = await readMessageEditorText(editor);
    if (entered !== reply) {
      throw new SiteAutomationError(
        "MESSAGE_EDITOR_MISMATCH",
        "The Douyin private-message editor did not contain the requested text.",
      );
    }
    if (asBoolean(dryRun)) {
      await clearMessageEditor(workspacePage, editor);
      await returnToConversationList(workspacePage);
      const row = await ownerConversationRow(workspacePage, settings);
      state.lastPreview = (await conversationSnapshot(row)).preview;
      writeState(settings, state);
      return {
        status: "validated",
        deliveryConfirmed: false,
        dryRun: true,
        text: reply,
        pendingMessages: pendingBefore,
      };
    }

    const before = await exactOutgoingCount(pane, reply);
    await editor.press("Enter");
    await workspacePage.waitForTimeout(400);
    const after = await exactOutgoingCount(pane, reply);
    if (after <= before) {
      throw new SiteAutomationError(
        "MESSAGE_SEND_NOT_CONFIRMED",
        "Douyin did not show a new outgoing private message.",
      );
    }

    state.pending = [];
    await returnToConversationList(workspacePage);
    const row = await ownerConversationRow(workspacePage, settings);
    state.lastPreview = (await conversationSnapshot(row)).preview;
    writeState(settings, state);
    return {
      status: "sent",
      deliveryConfirmed: true,
      recipient: settings.displayName,
      text: reply,
      acknowledgedMessages: pendingBefore,
    };
  } finally {
    await returnToConversationList(workspacePage).catch(() => null);
    await feedPage.bringToFront().catch(() => null);
  }
}

async function groupMessageEditor(pane) {
  const editors = pane.locator("div[contenteditable='true']");
  const editorCount = await editors.count();
  for (let index = 0; index < editorCount; index += 1) {
    const candidate = editors.nth(index);
    if (await isVisible(candidate)) return candidate;
  }
  throw new SiteAutomationError(
    "GROUP_MESSAGE_EDITOR_NOT_FOUND",
    "Could not find the visible Douyin group-message editor.",
  );
}

async function ownerMentionCandidate(page, ownerDisplayName) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidates = page.locator(".MentionMentionItemcontainer");
    const matches = [];
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await isVisible(candidate))) continue;
      const name = candidate.locator(".MentionMentionItemuserName");
      if (
        (await isVisible(name)) &&
        cleanText(await name.innerText(), 100) === ownerDisplayName
      ) {
        matches.push(candidate);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new SiteAutomationError(
        "GROUP_OWNER_MENTION_AMBIGUOUS",
        `More than one mention target matches: ${ownerDisplayName}.`,
      );
    }
    await page.waitForTimeout(100);
  }
  throw new SiteAutomationError(
    "GROUP_OWNER_MENTION_NOT_FOUND",
    `Could not find the owner mention target: ${ownerDisplayName}.`,
  );
}

async function fillGroupConsentRequest({
  workspacePage,
  editor,
  ownerDisplayName,
  question,
}) {
  await editor.fill("");
  await editor.click();
  await editor.type("@");
  const target = await ownerMentionCandidate(workspacePage, ownerDisplayName);
  await target.click();
  // Douyin briefly renders a duplicate mention while it commits the selection.
  // Wait for that editor update before appending the natural-language question.
  await workspacePage.waitForTimeout(350);
  await editor.type(question);
  const mention = editor.locator("[data-apm-action='输入框@']");
  const mentionCount = await mention.count();
  if (mentionCount !== 1) {
    throw new SiteAutomationError(
      "GROUP_OWNER_MENTION_MISMATCH",
      "The Douyin group-message editor did not settle on exactly one owner mention.",
      { mentionCount },
    );
  }
  await mention.waitFor({ state: "visible", timeout: 3000 });
  const actualMention = cleanEditorText(await mention.textContent());
  const entered = cleanEditorText(await editor.textContent());
  if (
    actualMention !== `@${ownerDisplayName}` ||
    !entered.endsWith(question)
  ) {
    throw new SiteAutomationError(
      "GROUP_OWNER_MENTION_MISMATCH",
      "The Douyin group-message editor did not preserve the selected owner mention.",
    );
  }
  return entered;
}

async function sendGroupMessage({
  feedPage,
  config,
  groupId = "",
  dryRun = false,
  compose,
  onMessageSent = null,
  resultDetails = {},
  dryRunResultDetails = {},
}) {
  const settings = requireGroupSettings(config, groupId);
  const owner = ownerSettings(config);
  const ownerDisplayName = owner.displayName;
  const ownerUserId = owner.userId;
  const state = readGroupState(settings);
  const workspacePage = await ensureMessageWorkspace(feedPage);
  let editor = null;
  try {
    const { pane } = await openGroupConversation(workspacePage, settings);
    const current = await latestGroupMessages(pane, {
      ownerDisplayName,
      ownerUserId,
    });
    const privacyConsent = resolvePendingPrivacyConsent({
      state,
      settings,
      messages: current,
    });

    // Group chat is live: a deliberate group-reply must not be cancelled merely
    // because a newer message arrived after the previous read.  The adapter
    // still opens the current conversation, confirms the outgoing bubble, and
    // refreshes the stored window after the send.
    editor = await groupMessageEditor(pane);
    const reply = cleanOutgoingMessageText(
      await compose({ workspacePage, pane, editor, ownerDisplayName }),
      4000,
    );
    if (!reply) {
      throw new SiteAutomationError(
        "MESSAGE_TEXT_REQUIRED",
        "The group-message text must not be empty.",
      );
    }
    const entered = await readMessageEditorText(editor);
    if (entered !== reply) {
      throw new SiteAutomationError(
        "GROUP_MESSAGE_EDITOR_MISMATCH",
        "The Douyin group-message editor did not contain the requested text.",
      );
    }
    if (asBoolean(dryRun)) {
      await clearMessageEditor(workspacePage, editor);
      return {
        status: "validated",
        deliveryConfirmed: false,
        dryRun: true,
        recipient: settings.displayName,
        conversationType: "group",
        text: reply,
        ...dryRunResultDetails,
        ...(privacyConsent ? { privacyConsent } : {}),
      };
    }

    const before = await exactOutgoingCount(pane, reply);
    await editor.press("Enter");
    await workspacePage.waitForTimeout(400);
    const after = await exactOutgoingCount(pane, reply);
    if (after <= before) {
      throw new SiteAutomationError(
        "GROUP_MESSAGE_SEND_NOT_CONFIRMED",
        "Douyin did not show a new outgoing group message.",
      );
    }

    const afterSend = await latestGroupMessages(pane, {
      ownerDisplayName,
      ownerUserId,
    });
    state.baselineComplete = true;
    state.lastWindowSignature = groupWindowSignature(afterSend);
    if (onMessageSent) {
      onMessageSent({ state, settings, reply, afterSend });
    }
    writeGroupState(settings, state);
    return {
      status: "sent",
      deliveryConfirmed: true,
      recipient: settings.displayName,
      conversationType: "group",
      text: reply,
      ...resultDetails,
      ...(privacyConsent ? { privacyConsent } : {}),
    };
  } catch (error) {
    if (editor) {
      await clearMessageEditor(workspacePage, editor).catch(() => null);
    }
    throw error;
  } finally {
    await returnToConversationList(workspacePage).catch(() => null);
    await feedPage.bringToFront().catch(() => null);
  }
}

export async function replyToGroup({
  feedPage,
  config,
  text,
  groupId = "",
  dryRun = false,
}) {
  const reply = cleanOutgoingMessageText(text, 4000);
  if (!reply) {
    throw new SiteAutomationError(
      "MESSAGE_TEXT_REQUIRED",
      "group-reply requires non-empty --text.",
    );
  }
  return sendGroupMessage({
    feedPage,
    config,
    groupId,
    dryRun,
    compose: async ({ editor }) => {
      await fillMultilineMessageEditor(editor, reply);
      return reply;
    },
  });
}

export async function requestGroupPrivacyConsent({
  feedPage,
  config,
  text,
  groupId = "",
  dryRun = false,
}) {
  const question = cleanText(text, 500);
  if (!question) {
    throw new SiteAutomationError(
      "PRIVACY_CONSENT_TEXT_REQUIRED",
      "group-request-consent requires a short non-empty --text question.",
    );
  }
  const owner = requireOwnerSettings(config);
  const requestId = crypto.randomUUID();
  return sendGroupMessage({
    feedPage,
    config,
    groupId,
    dryRun,
    compose: ({ workspacePage, editor, ownerDisplayName }) =>
      fillGroupConsentRequest({
        workspacePage,
        editor,
        ownerDisplayName,
        question,
      }),
    onMessageSent: ({ state, reply }) => {
      state.pendingPrivacyConsent = {
        requestId,
        requestText: reply,
        requestedAt: new Date().toISOString(),
      };
    },
    resultDetails: {
      privacyConsentRequest: {
        requestId,
        status: "awaiting-owner-decision",
        owner: owner.displayName,
      },
    },
  });
}

async function shareTarget(page, settings) {
  let lastNameMatchCount = 0;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (settings.userId) {
      const exact = page.locator(`[data-userid="${settings.userId}"]`);
      const count = await exact.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = exact.nth(index);
        if (await isVisible(candidate)) return candidate;
      }
    }

    const names = page.getByText(settings.displayName, { exact: true });
    const matches = [];
    const count = await names.count();
    for (let index = 0; index < count; index += 1) {
      const name = names.nth(index);
      if (await isVisible(name)) matches.push(name);
    }
    lastNameMatchCount = matches.length;
    if (matches.length === 1) {
      const row = matches[0].locator(
        "xpath=ancestor::*[.//*[@data-userid] or .//*[normalize-space(text())='分享']][1]",
      );
      const button = row.getByText("分享", { exact: true });
      if (await isVisible(button)) return button;
    }
    await page.waitForTimeout(250);
  }

  throw new SiteAutomationError(
    lastNameMatchCount > 1
      ? "SHARE_TARGET_AMBIGUOUS"
      : "SHARE_TARGET_NOT_FOUND",
    `Could not uniquely identify the configured share target: ${settings.displayName}`,
    { count: lastNameMatchCount },
  );
}

export async function shareCurrentWithOwner({
  feedPage,
  config,
  dryRun = false,
}) {
  const settings = requireOwnerSettings(config);
  const originalUrl = feedPage.url();
  const detailItemId =
    originalUrl.match(/\/video\/(\d+)/u)?.[1] || "";
  let restoreDetailPage = false;
  try {
    if (detailItemId) {
      const modalUrl = new URL("https://www.douyin.com/");
      modalUrl.searchParams.set("modal_id", detailItemId);
      modalUrl.searchParams.set("recommend", "1");
      await feedPage.goto(modalUrl.href, { waitUntil: "domcontentloaded" });
      await feedPage
        .waitForFunction(
          (itemId) => {
            const container = document.querySelector(
              `[data-e2e='feed-active-video'][data-e2e-vid='${itemId}']`,
            );
            const share = container?.querySelector(
              "[data-e2e='video-player-share']",
            );
            if (!share) return false;
            const rect = share.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          detailItemId,
          { timeout: 12_000 },
        )
        .catch(() => null);
      restoreDetailPage = true;
    }

    const share = detailItemId
      ? feedPage.locator(
          `[data-e2e='feed-active-video'][data-e2e-vid='${detailItemId}'] ` +
            "[data-e2e='video-player-share']",
        ).first()
      : feedPage.locator(
          "[data-e2e='feed-active-video'] [data-e2e='video-player-share']",
        ).first();
    if (!(await isVisible(share))) {
      throw new SiteAutomationError(
        "SHARE_CONTROL_NOT_FOUND",
        "Could not find the current Douyin video's Share control.",
      );
    }

    await share.click();
    const target = await shareTarget(feedPage, settings);
    if (asBoolean(dryRun)) {
      await feedPage.keyboard.press("Escape").catch(() => null);
      return {
        status: "validated",
        deliveryConfirmed: false,
        dryRun: true,
        recipient: settings.displayName,
        shareMethod: "native",
      };
    }

    await target.click();
    const success = feedPage.getByText("分享成功", { exact: true });
    await success.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);
    const confirmed = await isVisible(success);
    await feedPage.keyboard.press("Escape").catch(() => null);
    if (!confirmed) {
      throw new SiteAutomationError(
        "SHARE_NOT_CONFIRMED",
        "Douyin did not show the Share succeeded confirmation.",
      );
    }
    return {
      status: "sent",
      deliveryConfirmed: true,
      recipient: settings.displayName,
      shareMethod: "native",
    };
  } finally {
    await feedPage.keyboard.press("Escape").catch(() => null);
    if (restoreDetailPage) {
      await feedPage
        .goto(originalUrl, { waitUntil: "domcontentloaded" })
        .catch(() => null);
      await feedPage.waitForTimeout(500).catch(() => null);
    }
  }
}
