import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SiteAutomationError } from "../../common/runtime.mjs";

const ADAPTER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(ADAPTER_ROOT, "../..");
const VISUAL_QUESTION =
  "只描述当前抖音画面里直接可见的主要人物、动作、环境和关键文字。不要根据标题猜测画面之外的内容；用简短中文回答。";
const VIDEO_QUESTION =
  "概括这段视频实际讲了什么：结合画面、语音和字幕，先说主题，再列出关键过程或观点；不要补写视频中没有的信息。结果用于决定是否继续观看。";

function asNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mediaConfig(config) {
  const raw =
    config?.douyin?.media && typeof config.douyin.media === "object"
      ? config.douyin.media
      : {};
  const resolveConfiguredPath = (value, fallback) =>
    value
      ? path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(config.runtimeRoot, value)
      : fallback;
  const runtimeRoot = resolveConfiguredPath(
    raw.runtimeDirectory,
    config?.douyin?.media?.runtimeDirectory || path.join(config.runtimeRoot, "douyin", "media"),
  );
  return {
    visionEnabled: raw.visionEnabled !== false,
    maxClipSeconds: asNumber(raw.maxClipSeconds, 30, 1, 30),
    maxAnalysisSeconds: asNumber(raw.maxAnalysisSeconds, 600, 1, 3_600),
    mediaCaptureTimeoutMs: asNumber(
      raw.mediaCaptureTimeoutMs,
      9_000,
      2_000,
      30_000,
    ),
    processTimeoutMs: asNumber(
      raw.processTimeoutMs,
      180_000,
      10_000,
      600_000,
    ),
    messagePollMs: asNumber(raw.messagePollMs, 500, 250, 5_000),
    suzuLivesCommand: String(raw.suzuLivesCommand || config.suzuLivesCommand || "suzu-lives"),
    dataRoot: String(config.dataRoot || ""),
    projectRoot: String(config.projectRoot || ""),
    ffmpegPath: String(raw.ffmpegPath || "ffmpeg"),
    runtimeRoot,
    keepScreenshots: raw.keepScreenshots === true,
    keepClips: raw.keepClips === true,
  };
}

function softwareCommandContext(settings) {
  const args = ["--data-root", settings.dataRoot];
  if (settings.projectRoot) args.push("--project-root", settings.projectRoot);
  return args;
}

export function visionCommandArgs(settings, imagePath, question) {
  return [
    "image-vision",
    imagePath,
    "--question",
    question,
    ...softwareCommandContext(settings),
  ];
}

export function videoCommandArgs(settings, videoPath, cacheKey, question) {
  return [
    "video-understanding",
    videoPath,
    "--cache-key",
    cacheKey,
    "--question",
    question,
    ...softwareCommandContext(settings),
  ];
}

function safeName(value) {
  return (
    String(value || "unknown")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 100) || "unknown"
  );
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""),
    );
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function watchProgressPath(settings) {
  return path.join(settings.runtimeRoot, "watch-progress.json");
}

function watchedUntil(settings, itemId) {
  const state = readJsonIfPresent(watchProgressPath(settings));
  const entry = state?.items?.[itemId];
  const seconds = Number(entry?.watchedUntilSeconds || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function updateWatchProgress(settings, itemId, endSeconds) {
  const filePath = watchProgressPath(settings);
  const state = readJsonIfPresent(filePath) || {};
  const items =
    state.items && typeof state.items === "object" ? state.items : {};
  const previous = Number(items[itemId]?.watchedUntilSeconds || 0);
  items[itemId] = {
    watchedUntilSeconds: Number(
      Math.max(previous, endSeconds).toFixed(3),
    ),
    updatedAt: new Date().toISOString(),
  };
  const newest = Object.entries(items)
    .sort(
      (left, right) =>
        Date.parse(right[1]?.updatedAt || 0) -
        Date.parse(left[1]?.updatedAt || 0),
    )
    .slice(0, 500);
  writeJsonAtomic(filePath, {
    version: 1,
    items: Object.fromEntries(newest),
  });
}

function compactProcessError(command, args, code, stderr) {
  const detail = String(stderr || "").trim().slice(-2_000);
  return `${command} ${args.join(" ")} failed (${code})${
    detail ? `: ${detail}` : ""
  }`;
}

export async function runProcess(
  command,
  args,
  {
    timeoutMs,
    checkMessages = null,
    messagePollMs = 500,
    cwd = MODULE_ROOT,
  },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let checkingMessages = false;
    let ownerMessageResult = null;

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (poller) clearInterval(poller);
      callback();
    };
    const interruptForOwner = (messageResult) => {
      ownerMessageResult = messageResult;
      child.kill();
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) =>
      finish(() => {
        if (ownerMessageResult) {
          resolve({
            interrupted: true,
            ownerMessageResult,
            code,
            signal,
            stdout,
            stderr,
          });
          return;
        }
        if (code !== 0) {
          reject(
            new Error(compactProcessError(command, args, code, stderr)),
          );
          return;
        }
        resolve({ interrupted: false, code, stdout, stderr });
      }),
    );

    const timeout = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new Error(`${command} timed out after ${timeoutMs} ms`)),
      );
    }, timeoutMs);

    const poller =
      typeof checkMessages === "function"
        ? setInterval(async () => {
            if (finished || checkingMessages || ownerMessageResult) return;
            checkingMessages = true;
            try {
              const result = await checkMessages();
              if (result?.status === "owner-message-pending") {
                interruptForOwner(result);
              }
            } catch {
              // Private-message detection must not corrupt the media task.
            } finally {
              checkingMessages = false;
            }
          }, messagePollMs)
        : null;
  });
}

async function currentVideoLocator(page, expectedItemId = null) {
  const expected = String(expectedItemId || "").trim();
  const expectedDetailPage =
    expected &&
    (() => {
      try {
        return new RegExp(`/video/${expected}/?$`, "u").test(
          new URL(page.url()).pathname,
        );
      } catch {
        return false;
      }
    })();
  const candidates = expected
    ? [
        page.locator(`[data-e2e-vid='${expected}'] video`),
        page.locator(
          `[data-e2e='feed-active-video'][data-e2e-vid='${expected}'] video`,
        ),
        // Video detail pages do not consistently expose data-e2e-vid even
        // though the URL already identifies the exact requested work.
        ...(expectedDetailPage ? [page.locator("video")] : []),
      ]
    : [
        page.locator("[data-e2e='feed-active-video'] video"),
        page.locator("[data-e2e='feed-live'] video"),
        page.locator("video"),
      ];
  for (const locator of candidates) {
    const count = Math.min(await locator.count(), 10);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (box && box.width >= 160 && box.height >= 160) return candidate;
    }
  }
  return null;
}

async function waitForCurrentVideo(
  page,
  expectedItemId = null,
  timeoutMs = 12_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const video = await currentVideoLocator(page, expectedItemId);
    if (video) return video;
    await page.waitForTimeout(250);
  }
  return null;
}

export async function addVisualObservation({
  page,
  observation,
  config,
}) {
  const settings = mediaConfig(config);
  if (!settings.visionEnabled) {
    return {
      ...observation,
      visual: { status: "disabled" },
    };
  }
  if (!["video", "live"].includes(observation.contentType)) {
    return {
      ...observation,
      visual: { status: "unavailable", reason: "no-active-visual-content" },
    };
  }

  const video = await currentVideoLocator(page);
  if (!video) {
    return {
      ...observation,
      visual: { status: "unavailable", reason: "visible-video-not-found" },
    };
  }

  const screenshotDirectory = ensureDirectory(
    path.join(settings.runtimeRoot, "screenshots"),
  );
  const cacheDirectory = ensureDirectory(
    path.join(settings.runtimeRoot, "visual-cache"),
  );
  const screenshotPath = path.join(
    screenshotDirectory,
    `${safeName(observation.contentKey || observation.itemId)}-${Date.now()}.jpg`,
  );
  await video.screenshot({
    path: screenshotPath,
    type: "jpeg",
    quality: 82,
  });
  const imageHash = sha256File(screenshotPath);
  const cachePath = path.join(cacheDirectory, `${imageHash}.json`);
  const cached = readJsonIfPresent(cachePath);
  if (cached?.summary) {
    if (!settings.keepScreenshots) {
      fs.rmSync(screenshotPath, { force: true });
    }
    return {
      ...observation,
      visual: {
        status: "ok",
        summary: cached.summary,
        cached: true,
      },
    };
  }

  try {
    const result = await runProcess(
      settings.suzuLivesCommand,
      visionCommandArgs(settings, screenshotPath, VISUAL_QUESTION),
      { timeoutMs: settings.processTimeoutMs },
    );
    const summary = String(result.stdout || "").trim();
    if (!summary) throw new Error("视觉模型返回空文本");
    writeJsonAtomic(cachePath, {
      imageHash,
      contentKey: observation.contentKey || "",
      summary,
      createdAt: new Date().toISOString(),
    });
    return {
      ...observation,
      visual: {
        status: "ok",
        summary,
        cached: false,
      },
    };
  } catch (error) {
    return {
      ...observation,
      visual: {
        status: "error",
        error: String(error?.message || error).slice(0, 1_000),
      },
    };
  } finally {
    if (!settings.keepScreenshots) {
      fs.rmSync(screenshotPath, { force: true });
    }
  }
}

function mediaKind(url, mimeType = "") {
  const normalizedUrl = String(url || "").toLowerCase();
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (normalizedUrl.includes("media-audio-")) return "audio";
  if (normalizedUrl.includes("media-video-")) return "video";
  if (normalizedMime.startsWith("video/")) return "video";
  if (normalizedMime.startsWith("audio/")) return "audio";
  return "";
}

function chooseTrack(entries, kind) {
  return entries
    .filter((entry) => entry.kind === kind)
    .sort((left, right) => right.seenAt - left.seenAt)[0]?.url;
}

function trackCandidates(entries, kind, maximum = 6) {
  const candidates = [];
  const seen = new Set();
  for (const entry of entries
    .filter((item) => item.kind === kind)
    .sort((left, right) => right.seenAt - left.seenAt)) {
    if (!entry.url || seen.has(entry.url)) continue;
    seen.add(entry.url);
    candidates.push(entry.url);
    if (candidates.length >= maximum) break;
  }
  return candidates;
}

async function captureCurrentTracks(
  page,
  timeoutMs,
  { reload = false, expectedItemId = null } = {},
) {
  let video = await currentVideoLocator(page, expectedItemId);
  if (!video) {
    throw new SiteAutomationError(
      "VIDEO_NOT_FOUND",
      "当前页面没有可见的视频元素。",
    );
  }

  const previous = await video.evaluate((element) => ({
    paused: element.paused,
    currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
    duration: Number.isFinite(element.duration) ? element.duration : 0,
    muted: element.muted,
    volume: element.volume,
    decodedAudioBytes: Number(element.webkitAudioDecodedByteCount || 0),
    capturedAudioTracks: (() => {
      try {
        return typeof element.captureStream === "function"
          ? element.captureStream().getAudioTracks().length
          : null;
      } catch {
        return null;
      }
    })(),
    currentSrc: element.currentSrc || element.src || "",
  }));
  const userAgent = await page.evaluate(() => navigator.userAgent);
  // Do not seed this list from historical Performance entries. The same tab
  // may previously have opened another shared video, and those stale tracks
  // can otherwise be mistaken for the currently visible work.
  const entries = [];
  if (/^https?:\/\//iu.test(previous.currentSrc)) {
    entries.push({
      url: previous.currentSrc,
      kind: "video",
      seenAt: Number.MAX_SAFE_INTEGER,
    });
  }

  const session = await page.context().newCDPSession(page);
  const requestKinds = new Map();
  const startedAt = Date.now();
  const addEntry = (url, kind) => {
    if (!url || !kind) return;
    entries.push({ url, kind, seenAt: Date.now() });
  };
  const onRequest = (event) => {
    const kind = mediaKind(event.request?.url, event.type || "");
    if (!kind) return;
    requestKinds.set(event.requestId, kind);
    addEntry(event.request.url, kind);
  };
  const onResponse = (event) => {
    const kind =
      requestKinds.get(event.requestId) ||
      mediaKind(event.response?.url, event.response?.mimeType);
    addEntry(event.response?.url, kind);
  };

  try {
    session.on("Network.requestWillBeSent", onRequest);
    session.on("Network.responseReceived", onResponse);
    await session.send("Network.enable");

    if (reload) {
      if (expectedItemId) {
        await page.goto(`https://www.douyin.com/video/${expectedItemId}`, {
          waitUntil: "domcontentloaded",
        });
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      video = await waitForCurrentVideo(page, expectedItemId);
      if (!video) {
        throw new SiteAutomationError(
          "VIDEO_NOT_FOUND_AFTER_RELOAD",
          "重新加载当前页面后没有找到可见视频。",
        );
      }
    }

    const seekPoints = previous.duration
      ? [
          Math.min(Math.max(previous.currentTime + 45, 1), previous.duration - 1),
          Math.min(2, Math.max(previous.duration - 0.5, 0)),
        ]
      : [45, 1];
    for (const seekPoint of seekPoints) {
      await video
        .evaluate(async (element, target) => {
          if (Number.isFinite(target) && target >= 0) {
            element.currentTime = target;
          }
          await element.play().catch(() => null);
        }, seekPoint)
        .catch(() => null);
      await page.waitForTimeout(900);
    }

    while (
      Date.now() - startedAt < timeoutMs &&
      (!chooseTrack(entries, "video") || !chooseTrack(entries, "audio"))
    ) {
      await page.waitForTimeout(250);
    }
  } finally {
    if (video) {
      await video
        .evaluate(async (element, state) => {
          element.currentTime = state.currentTime;
          element.muted = state.muted;
          element.volume = state.volume;
          if (state.paused) {
            element.pause();
          } else {
            await element.play().catch(() => null);
          }
        }, previous)
        .catch(() => null);
    }
    session.off("Network.requestWillBeSent", onRequest);
    session.off("Network.responseReceived", onResponse);
    await session.send("Network.disable").catch(() => null);
    await session.detach().catch(() => null);
  }

  const videoUrl = chooseTrack(entries, "video");
  const audioUrl = chooseTrack(entries, "audio");
  if (!videoUrl) {
    throw new SiteAutomationError(
      "MEDIA_TRACKS_NOT_FOUND",
      "无法从当前抖音视频捕获视频媒体资源。",
      {
        audioTrackFound: Boolean(audioUrl),
        observedMediaRequests: entries.length,
        reloaded: reload,
      },
    );
  }
  return {
    videoUrl,
    audioUrl: audioUrl || "",
    videoUrls: trackCandidates(entries, "video"),
    audioUrls: trackCandidates(entries, "audio"),
    previous,
    reloaded: reload,
    playbackHasAudio:
      Number(previous.capturedAudioTracks || 0) > 0 ||
      Number(previous.decodedAudioBytes || 0) > 0,
    userAgent,
  };
}

function clipExportArgs(
  tracks,
  startSeconds,
  clipSeconds,
  clipPath,
  videoOnly = false,
) {
  const input = (url) => [
    "-user_agent",
    tracks.userAgent,
    "-headers",
    "Referer: https://www.douyin.com/\r\n",
    ...(startSeconds > 0 ? ["-ss", startSeconds.toFixed(3)] : []),
    "-i",
    url,
  ];
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...input(tracks.videoUrl),
  ];
  if (tracks.audioUrl) {
    common.push(...input(tracks.audioUrl));
  }
  common.push(
    "-t",
    clipSeconds.toFixed(3),
    "-map",
    "0:v:0",
  );
  if (videoOnly) {
    common.push("-an");
  } else {
    common.push("-map", tracks.audioUrl ? "1:a:0" : "0:a:0");
  }
  common.push(
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    clipPath,
  );
  return common;
}

async function tryExportClip({
  settings,
  tracks,
  startSeconds,
  clipSeconds,
  clipPath,
  checkMessages,
  videoOnly = false,
}) {
  fs.rmSync(clipPath, { force: true });
  try {
    const result = await runProcess(
      settings.ffmpegPath,
      clipExportArgs(
        tracks,
        startSeconds,
        clipSeconds,
        clipPath,
        videoOnly,
      ),
      {
        timeoutMs: settings.processTimeoutMs,
        checkMessages,
        messagePollMs: settings.messagePollMs,
      },
    );
    return {
      status: result.interrupted ? "interrupted" : "ok",
      result,
      mode: videoOnly
        ? "video-only"
        : tracks.audioUrl
          ? "separate-tracks"
          : "combined-file",
    };
  } catch {
    fs.rmSync(clipPath, { force: true });
    return { status: "failed", result: null, mode: "" };
  }
}

async function tryExportCandidates({
  settings,
  tracks,
  startSeconds,
  clipSeconds,
  clipPath,
  checkMessages,
}) {
  const videoUrls =
    Array.isArray(tracks.videoUrls) && tracks.videoUrls.length > 0
      ? tracks.videoUrls
      : [tracks.videoUrl].filter(Boolean);
  const audioUrls =
    Array.isArray(tracks.audioUrls) && tracks.audioUrls.length > 0
      ? tracks.audioUrls
      : [tracks.audioUrl].filter(Boolean);

  for (const videoUrl of videoUrls) {
    const combined = await tryExportClip({
      settings,
      tracks: { ...tracks, videoUrl, audioUrl: "" },
      startSeconds,
      clipSeconds,
      clipPath,
      checkMessages,
    });
    if (combined.status !== "failed") return combined;
  }

  for (const videoUrl of videoUrls) {
    for (const audioUrl of audioUrls) {
      const separated = await tryExportClip({
        settings,
        tracks: { ...tracks, videoUrl, audioUrl },
        startSeconds,
        clipSeconds,
        clipPath,
        checkMessages,
      });
      if (separated.status !== "failed") return separated;
    }
  }
  return { status: "failed", result: null, mode: "" };
}

function ownerInterruptedResult(ownerMessageResult, phase) {
  return {
    ...ownerMessageResult,
    interruptedAction: "understand-current",
    interruptedPhase: phase,
    videoUnderstandingCompleted: false,
  };
}

async function currentNoteImageSources(page, itemId) {
  await page
    .waitForFunction(
      (expectedItemId) => {
        const root =
          document.querySelector(".note-detail-container") ||
          document;
        return [...root.querySelectorAll("img")].some((image) =>
          /aweme-images|biz_tag=aweme_images/u.test(
            image.currentSrc || image.src || "",
          ),
        );
      },
      itemId,
      { timeout: 10_000 },
    )
    .catch(() => null);
  return page.evaluate((expectedItemId) => {
    const root =
      document.querySelector(".note-detail-container") ||
      document;
    const seen = new Set();
    const urls = [];
    for (const image of root.querySelectorAll("img")) {
      const url = image.currentSrc || image.src || "";
      if (
        !/aweme-images|biz_tag=aweme_images/u.test(url) ||
        seen.has(url)
      ) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }
    return urls;
  }, itemId);
}

export async function understandCurrentNote({
  page,
  observation,
  config,
  checkMessages = null,
}) {
  if (!observation?.itemId) {
    throw new SiteAutomationError(
      "NOTE_REQUIRED",
      "当前图文没有可用的作品 ID。",
    );
  }
  const settings = mediaConfig(config);
  const imageUrls = await currentNoteImageSources(
    page,
    observation.itemId,
  );
  if (imageUrls.length === 0) {
    throw new SiteAutomationError(
      "NOTE_IMAGES_NOT_FOUND",
      "图文详情已经打开，但没有找到可读取的图集图片。",
      { itemId: observation.itemId },
    );
  }

  const noteDirectory = ensureDirectory(
    path.join(
      settings.runtimeRoot,
      "notes",
      `${safeName(observation.itemId)}-${Date.now()}`,
    ),
  );
  const summaries = [];
  try {
    for (let index = 0; index < imageUrls.length; index += 1) {
      if (typeof checkMessages === "function") {
        const messageResult = await checkMessages().catch(() => null);
        if (messageResult?.status === "owner-message-pending") {
          return ownerInterruptedResult(messageResult, "note-understanding");
        }
      }

      const imagePath = path.join(
        noteDirectory,
        `${String(index + 1).padStart(2, "0")}.webp`,
      );
      const response = await page.context().request.get(imageUrls[index], {
        headers: {
          Referer: "https://www.douyin.com/",
        },
        timeout: settings.processTimeoutMs,
      });
      if (!response.ok()) {
        throw new SiteAutomationError(
          "NOTE_IMAGE_DOWNLOAD_FAILED",
          `下载图文第 ${index + 1} 张图片失败（HTTP ${response.status()}）。`,
        );
      }
      fs.writeFileSync(imagePath, await response.body());

      const question =
        `这是同一条抖音图文的第 ${index + 1}/${imageUrls.length} 张。` +
        "请用不超过80字说明这张图直接可见的画面和关键文字；保留理解整组图文所需的梗、对比或前后关系，不要猜测看不清的内容。";
      const visionResult = await runProcess(
        settings.suzuLivesCommand,
        visionCommandArgs(settings, imagePath, question),
        {
          timeoutMs: settings.processTimeoutMs,
          checkMessages,
          messagePollMs: settings.messagePollMs,
        },
      );
      if (visionResult.interrupted) {
        return ownerInterruptedResult(
          visionResult.ownerMessageResult,
          "note-understanding",
        );
      }
      const summary = String(visionResult.stdout || "").trim();
      if (!summary) {
        throw new SiteAutomationError(
          "NOTE_IMAGE_RESULT_EMPTY",
          `视觉模型没有返回图文第 ${index + 1} 张的内容。`,
        );
      }
      summaries.push(`${index + 1}. ${summary}`);
    }
  } finally {
    if (!settings.keepScreenshots) {
      fs.rmSync(noteDirectory, { recursive: true, force: true });
    }
  }

  return {
    status: "ok",
    observation: {
      ...observation,
      pageType: "note",
      contentType: "note",
      video: null,
    },
    understanding: {
      summary: `图文共 ${summaries.length} 张：\n${summaries.join("\n")}`,
      analyzedImages: summaries.length,
    },
  };
}

export async function understandCurrentVideo({
  page,
  observation,
  config,
  checkMessages,
  startSecond = null,
  endSecond = null,
  requestedSeconds = null,
}) {
  if (
    observation.contentType !== "video" ||
    !observation.itemId ||
    !observation.video
  ) {
    throw new SiteAutomationError(
      "VIDEO_REQUIRED",
      "understand-current 只能用于当前普通视频，直播预览和直播间不支持。",
    );
  }

  const settings = mediaConfig(config);
  const sourceDuration = Number(observation.video.duration || 0);
  const storedStart = watchedUntil(settings, observation.itemId);
  const explicitStart = optionalNumber(startSecond);
  const explicitEnd = optionalNumber(endSecond);
  const requested = optionalNumber(requestedSeconds);
  const startSeconds =
    Number.isFinite(explicitStart) && explicitStart >= 0
      ? explicitStart
      : storedStart;
  if (sourceDuration > 0 && startSeconds >= sourceDuration) {
    return {
      status: "video-ended",
      observation,
      understanding: {
        summary: "这个视频已经看到结尾了。",
        analyzedSeconds: 0,
        range: {
          startSeconds: Number(startSeconds.toFixed(3)),
          endSeconds: Number(sourceDuration.toFixed(3)),
        },
        nextStartSeconds: Number(sourceDuration.toFixed(3)),
        sourceDurationSeconds: Number(sourceDuration.toFixed(3)),
      },
    };
  }
  const requestedEnd =
    Number.isFinite(explicitEnd) && explicitEnd > startSeconds
      ? explicitEnd
      : startSeconds +
        (Number.isFinite(requested) && requested > 0
          ? requested
          : settings.maxClipSeconds);
  const endSeconds = Math.min(
    requestedEnd,
    startSeconds + settings.maxAnalysisSeconds,
    sourceDuration > 0 ? sourceDuration : requestedEnd,
  );
  const clipSeconds = Math.max(0, endSeconds - startSeconds);
  if (clipSeconds <= 0) {
    throw new SiteAutomationError(
      "VIDEO_RANGE_INVALID",
      "视频理解范围无效：结束时间必须大于开始时间。",
      { startSecond, endSecond, requestedSeconds },
    );
  }

  const clipDirectory = ensureDirectory(
    path.join(settings.runtimeRoot, "clips"),
  );
  const clipPath = path.join(
    clipDirectory,
    `${safeName(observation.itemId)}-${Math.floor(startSeconds)}-${Math.ceil(
      endSeconds,
    )}s.mp4`,
  );
  let mediaMode = "cached-clip";
  let tracks = null;

  if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 1_024) {
    tracks = await captureCurrentTracks(
      page,
      settings.mediaCaptureTimeoutMs,
      { expectedItemId: observation.itemId },
    ).catch(() => null);
    let exported = tracks
      ? await tryExportCandidates({
          settings,
          tracks,
          startSeconds,
          clipSeconds,
          clipPath,
          checkMessages,
        })
      : { status: "failed", result: null, mode: "" };

    if (exported.status === "interrupted") {
      fs.rmSync(clipPath, { force: true });
      return ownerInterruptedResult(
        exported.result.ownerMessageResult,
        "clip-export",
      );
    }

    if (exported.status !== "ok") {
      tracks = await captureCurrentTracks(
        page,
        settings.mediaCaptureTimeoutMs,
        { reload: true, expectedItemId: observation.itemId },
      );
      exported = await tryExportCandidates({
        settings,
        tracks,
        startSeconds,
        clipSeconds,
        clipPath,
        checkMessages,
      });
      if (exported.status === "interrupted") {
        fs.rmSync(clipPath, { force: true });
        return ownerInterruptedResult(
          exported.result.ownerMessageResult,
          "clip-export",
        );
      }
    }

    if (
      exported.status !== "ok" &&
      tracks &&
      tracks.playbackHasAudio === false
    ) {
      exported = await tryExportClip({
        settings,
        tracks,
        startSeconds,
        clipSeconds,
        clipPath,
        checkMessages,
        videoOnly: true,
      });
      if (exported.status === "interrupted") {
        fs.rmSync(clipPath, { force: true });
        return ownerInterruptedResult(
          exported.result.ownerMessageResult,
          "clip-export",
        );
      }
    }

    if (exported.status !== "ok") {
      throw new SiteAutomationError(
        "MEDIA_EXPORT_FAILED",
        `无法导出视频第 ${startSeconds.toFixed(0)}-${endSeconds.toFixed(
          0,
        )} 秒的可理解片段。`,
        {
          videoTrackFound: Boolean(tracks?.videoUrl),
          audioTrackFound: Boolean(tracks?.audioUrl),
          videoCandidateCount: tracks?.videoUrls?.length || 0,
          audioCandidateCount: tracks?.audioUrls?.length || 0,
          playbackHasAudio: tracks?.playbackHasAudio ?? null,
          reloaded: tracks?.reloaded === true,
        },
      );
    }
    mediaMode = exported.mode;
  }

  const rangeQuestion =
    `${VIDEO_QUESTION} 这是原视频第 ${startSeconds.toFixed(
      0,
    )}-${endSeconds.toFixed(0)} 秒的一段连续内容；` +
    "只概括这个时间范围，并保留与前后内容衔接所需的人名、对象和未完成事项。";
  const videoResult = await runProcess(
    settings.suzuLivesCommand,
    videoCommandArgs(
      settings,
      clipPath,
      `douyin:${observation.itemId}:${startSeconds.toFixed(3)}:${clipSeconds.toFixed(3)}`,
      rangeQuestion,
    ),
    {
      timeoutMs: settings.processTimeoutMs,
      checkMessages,
      messagePollMs: settings.messagePollMs,
    },
  );
  if (videoResult.interrupted) {
    return ownerInterruptedResult(
      videoResult.ownerMessageResult,
      "video-understanding",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(
      String(videoResult.stdout || "").replace(/^\uFEFF/u, ""),
    );
  } catch (error) {
    throw new SiteAutomationError(
      "VIDEO_RESULT_INVALID",
      `视频理解脚本没有返回有效 JSON：${error.message}`,
      { output: String(videoResult.stdout || "").slice(-2_000) },
    );
  }
  if (parsed.status !== "ok") {
    throw new SiteAutomationError(
      "VIDEO_UNDERSTANDING_FAILED",
      parsed.message || "视频理解失败。",
      { result: parsed, startSeconds, clipSeconds },
    );
  }

  if (!settings.keepClips) {
    fs.rmSync(clipPath, { force: true });
  }
  updateWatchProgress(settings, observation.itemId, endSeconds);
  return {
    status: "ok",
    observation,
    understanding: {
      summary: parsed.summary,
      durationSeconds: parsed.durationSeconds,
      analyzedSeconds: Number(clipSeconds.toFixed(3)),
      range: {
        startSeconds: Number(startSeconds.toFixed(3)),
        endSeconds: Number(endSeconds.toFixed(3)),
      },
      nextStartSeconds: Number(endSeconds.toFixed(3)),
      sourceDurationSeconds:
        sourceDuration > 0 ? Number(sourceDuration.toFixed(3)) : null,
      cached: parsed.cached === true,
      model: parsed.responseModel || parsed.model || "",
      usage: parsed.usage || null,
      mediaMode,
    },
  };
}

