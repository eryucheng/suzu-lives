import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SiteAutomationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SiteAutomationError";
    this.code = code;
    this.details = details;
  }
}

export function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function cleanText(value, limit = 2000) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

export function operationKey(site, itemId, action, payload = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ site, itemId, action, payload }))
    .digest("hex");
}

export function hasSuccessfulOperation(logPath, key) {
  if (!fs.existsSync(logPath)) return false;
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/u).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry.key === key) return entry.status === "success";
    } catch {
      // Ignore a truncated final runtime record.
    }
  }
  return false;
}

export function appendOperation(logPath, value) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      ...value,
    })}\n`,
    "utf8",
  );
}

export async function saveDiagnostics(page, config, site, action, error) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const directory = path.join(config.diagnosticsDirectory, `${stamp}-${site}-${action}`);
  fs.mkdirSync(directory, { recursive: true });

  const metadata = {
    site,
    action,
    url: page?.url?.() || "",
    title: "",
    error: error?.message || String(error),
    code: error?.code || "AUTOMATION_FAILED",
    capturedAt: new Date().toISOString(),
  };

  if (page) {
    try {
      metadata.title = await page.title();
    } catch {
      // Keep the rest of the diagnostic bundle.
    }
    try {
      await page.screenshot({
        path: path.join(directory, "page.png"),
        fullPage: false,
      });
    } catch {
      // The page may already be gone.
    }
    try {
      fs.writeFileSync(path.join(directory, "page.html"), await page.content(), "utf8");
    } catch {
      // Metadata remains useful by itself.
    }
  }

  fs.writeFileSync(
    path.join(directory, "diagnostic.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
  return directory;
}

export function parseCliOptions(values) {
  const options = {};
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { options, positional };
}


