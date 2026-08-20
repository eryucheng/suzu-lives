import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { resolveMailBridgePaths } from "@suzu-lives/mail-bridge";

const MAX_MEDIA_ITEMS = 24;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function receiverScriptPath(paths, { packaged = false, resourcesPath = process.resourcesPath } = {}) {
  if (packaged && clean(resourcesPath)) {
    return path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@suzu-lives", "mail-bridge", "python", "receive_mail.py");
  }
  return paths.receiveScriptPath;
}

function targetSessions(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const source = plainObject(entry);
    const sessionId = clean(source.sessionId);
    const projectRoot = clean(source.projectRoot);
    if (!sessionId || !projectRoot || !path.isAbsolute(projectRoot)) return [];
    const normalizedRoot = path.resolve(projectRoot);
    const key = `${process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot}\u0000${sessionId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ sessionId, projectRoot: normalizedRoot }];
  });
}

function feedbackEvent(value) {
  const source = plainObject(value);
  if (clean(source.type) !== "mail-feedback") return null;
  const uid = Number(source.uid);
  const prompt = clean(source.prompt);
  if (!Number.isSafeInteger(uid) || uid < 1 || !prompt) return null;
  return { uid, prompt, attachments: Array.isArray(source.attachments) ? source.attachments : [] };
}

async function feedbackMedia(entries, inboxPath, fsOps = fs) {
  const media = [];
  for (const entry of entries.slice(0, MAX_MEDIA_ITEMS)) {
    const source = plainObject(entry);
    if (clean(source.kind).toLowerCase() !== "image") throw new Error("邮件反馈附件类型无效。 ");
    const sourcePath = clean(source.path);
    if (!sourcePath || !path.isAbsolute(sourcePath) || !inside(inboxPath, sourcePath)) {
      throw new Error("邮件反馈附件不在软件收件目录内。 ");
    }
    const resolved = path.resolve(sourcePath);
    const stat = await fsOps.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_MEDIA_BYTES) {
      throw new Error("邮件反馈附件不可读取或超过大小上限。 ");
    }
    const data = await fsOps.readFile(resolved);
    if (data.length !== stat.size) throw new Error("邮件反馈附件在读取时发生变化。 ");
    const mimeType = clean(source.mimeType) || "image/jpeg";
    media.push({
      kind: "image",
      path: resolved,
      fileName: path.basename(clean(source.fileName) || resolved),
      mimeType,
      data,
    });
  }
  return media;
}

function writeAcknowledgement(child, uid, accepted, message = "") {
  if (!child?.stdin?.writable) return;
  child.stdin.write(`${JSON.stringify({ type: "ack", uid, accepted, message: clean(message) })}\n`);
}

/**
 * Owns the shared IMAP receiver while Suzu is running. The Python
 * process only emits local JSON events; this service selects every configured
 * conversation and uses the normal per-session chat queue for delivery.
 */
export function createMailFeedbackLinkService({
  chat,
  settingsProvider,
  configuredTargets = () => [],
  fsOps = fs,
  spawnImpl = spawn,
  pythonCommand = () => process.env.SUZU_LIVES_PYTHON || process.env.PYTHON || "python",
  packaged = false,
  resourcesPath = process.resourcesPath,
  receiverPath = "",
  onState = () => {},
} = {}) {
  if (!chat?.sendToSession) throw new Error("邮件反馈需要会话聊天服务。 ");
  if (typeof settingsProvider !== "function") throw new Error("邮件反馈需要当前软件设置。 ");

  let child = null;
  let disposed = false;
  let generation = 0;
  let lastError = "";
  let started = false;

  const report = () => {
    try { onState({ started, lastError }); } catch { /* Status listeners cannot affect mail delivery. */ }
  };

  const stop = () => {
    generation += 1;
    const current = child;
    child = null;
    started = false;
    if (current) {
      try { current.kill?.(); } catch { /* The receiver may already be exiting. */ }
    }
    report();
  };

  const start = async () => {
    stop();
    if (disposed) return { started: false, reason: "disposed" };
    const settings = plainObject(settingsProvider());
    const dataRoot = clean(settings.dataRoot);
    const targets = targetSessions(await Promise.resolve(configuredTargets()));
    if (!dataRoot || !targets.length) return { started: false, reason: "not-configured" };

    let paths;
    try {
      paths = resolveMailBridgePaths({ dataRoot });
      const config = await fsOps.lstat(paths.configPath);
      if (config.isSymbolicLink() || !config.isFile()) throw new Error("邮箱通道配置不是安全的普通文件。 ");
    } catch (error) {
      lastError = clean(error?.message) || "邮箱通道尚未完成设置。";
      report();
      return { started: false, reason: "config-missing" };
    }

    const currentGeneration = ++generation;
    const scriptPath = clean(receiverPath) || receiverScriptPath(paths, { packaged, resourcesPath });
    let next;
    try {
      next = spawnImpl(clean(pythonCommand()) || "python", [
        scriptPath,
        "--config", paths.configPath,
        "--state", paths.statePath,
        "--watch",
        "--event-stream",
      ], {
        cwd: paths.runtimeRoot,
        env: { ...process.env, SUZU_LIVES_MAIL_INBOX_DIR: paths.inboxPath },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      lastError = clean(error?.message) || "无法启动邮件反馈监听。";
      report();
      return { started: false, reason: "spawn-failed" };
    }
    if (!next?.stdout || !next?.stdin) {
      try { next?.kill?.(); } catch { /* A partial process cannot be used. */ }
      lastError = "无法建立邮件反馈监听的本地输入输出通道。";
      report();
      return { started: false, reason: "invalid-process" };
    }
    if (disposed || currentGeneration !== generation) {
      try { next.kill?.(); } catch { /* The settings changed while it was starting. */ }
      return { started: false, reason: "restarted" };
    }

    child = next;
    started = true;
    lastError = "";
    const output = readline.createInterface({ input: next.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      const event = feedbackEvent(raw);
      if (!event || child !== next || disposed) return;
      void (async () => {
        try {
          const freshTargets = targetSessions(await Promise.resolve(configuredTargets()));
          if (!freshTargets.length) throw new Error("没有已启用的目标会话。 ");
          const media = await feedbackMedia(event.attachments, paths.inboxPath, fsOps);
          const deliveries = await Promise.allSettled(freshTargets.map((target) => chat.sendToSession({
            content: event.prompt,
            sessionId: target.sessionId,
            projectRoot: target.projectRoot,
            hasTranscript: true,
            kind: "mail-feedback",
            media,
            mediaSource: "mail",
          })));
          const failure = deliveries.find((item) => item.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          writeAcknowledgement(next, event.uid, true);
        } catch (error) {
          lastError = clean(error?.message) || "邮件反馈无法投递。";
          writeAcknowledgement(next, event.uid, false, lastError);
          report();
        }
      })();
    });
    next.once?.("error", (error) => {
      if (child !== next) return;
      child = null;
      started = false;
      lastError = clean(error?.message) || "邮件反馈监听已停止。";
      report();
    });
    next.once?.("close", () => {
      output.close();
      if (child !== next) return;
      child = null;
      started = false;
      report();
    });
    report();
    return { started: true, paths };
  };

  const restart = async () => start();
  const dispose = () => {
    disposed = true;
    stop();
  };

  return { start, restart, stop, dispose, snapshot: () => ({ started, lastError }) };
}
