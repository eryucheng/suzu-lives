import fs from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT_CHARS = 6_000;

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, maximum = MAX_OUTPUT_CHARS) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n…[truncated]`;
}

/**
 * Keep development-launch diagnostics out of C: by default.  The location is
 * intentionally separate from durable user data: it is a launcher trace, not
 * part of a contact or an Agent's memory.
 */
export function resolveDesktopStartupDiagnosticDirectory({
  environment = process.env,
  platform = process.platform,
} = {}) {
  const configured = clean(environment.SUZU_LIVES_STARTUP_LOG_DIRECTORY);
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  if (platform === "win32") return path.join("D:\\Temp", "suzu-lives-desktop-startup");
  const temporaryRoot = clean(environment.TMPDIR) || clean(environment.TEMP) || clean(environment.TMP) || "/tmp";
  return path.join(temporaryRoot, "suzu-lives-desktop-startup");
}

function diagnosticRecord(event, details = {}) {
  const source = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  return `${JSON.stringify({
    at: new Date().toISOString(),
    event: clean(event) || "unknown",
    ...source,
  })}\n`;
}

/**
 * A best-effort, append-only log.  Diagnostics must never stop Suzu from
 * launching, even when D:\Temp is temporarily unavailable.
 */
export function createDesktopStartupDiagnostics({
  directory = resolveDesktopStartupDiagnosticDirectory(),
  fsOps = fs,
} = {}) {
  const targetDirectory = path.resolve(String(directory));
  const logPath = path.join(targetDirectory, "desktop-startup.jsonl");
  let writes = Promise.resolve();

  const record = (event, details = {}) => {
    const line = diagnosticRecord(event, details);
    writes = writes
      .then(async () => {
        await fsOps.mkdir(targetDirectory, { recursive: true });
        await fsOps.appendFile(logPath, line, "utf8");
      })
      .catch(() => undefined);
  };

  return Object.freeze({
    directory: targetDirectory,
    logPath,
    record,
    recordOutput(event, output) {
      record(event, { output: bounded(output) });
    },
    flush: () => writes,
  });
}
