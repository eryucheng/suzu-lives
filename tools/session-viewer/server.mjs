#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = Object.freeze({
  port: 8765,
  pollIntervalMs: 2000,
  maxMessages: 500,
  maxRecords: 2500,
});

const BINARY_KEY = /(?:base64|image[_-]?data|audio[_-]?data|file[_-]?data)/iu;
const DATA_URL = /^data:[^;,]+;base64,/iu;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function optionValue(args, name) {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return number;
}

export function resolveRuntimeOptions(args = process.argv.slice(2)) {
  const localConfig = readJson(path.join(HERE, "config.local.json"));
  const compactorConfig = readJson(path.resolve(HERE, "..", "..", "memory", "manual_compactor", "config.local.json"));
  const argumentPath = optionValue(args, "--transcript") || process.env.SUZU_TRANSCRIPT_PATH;
  const sessionFilePath = argumentPath || localConfig.sessionFilePath || compactorConfig.transcriptPath;
  if (!sessionFilePath) {
    throw new Error("没有找到会话 JSONL。请填写 config.local.json，或使用 --transcript 指定文件。");
  }

  return {
    sessionFilePath: path.resolve(sessionFilePath),
    port: boundedInteger(optionValue(args, "--port") ?? localConfig.port, DEFAULTS.port, 1, 65535, "port"),
    pollIntervalMs: boundedInteger(localConfig.pollIntervalMs, DEFAULTS.pollIntervalMs, 500, 60000, "pollIntervalMs"),
    maxMessages: boundedInteger(optionValue(args, "--max") ?? localConfig.maxMessages, DEFAULTS.maxMessages, 20, 2000, "maxMessages"),
    maxRecords: boundedInteger(localConfig.maxRecords, DEFAULTS.maxRecords, 100, 10000, "maxRecords"),
  };
}

export class JsonlTail {
  constructor(sessionFilePath, maxRecords = DEFAULTS.maxRecords) {
    this.sessionFilePath = path.resolve(sessionFilePath);
    this.maxRecords = maxRecords;
    this.reset();
    this.refreshing = null;
  }

  reset() {
    this.records = [];
    this.offset = 0;
    this.identity = "";
    this.remainder = "";
    this.decoder = new StringDecoder("utf8");
    this.scannedRecords = 0;
    this.malformedLines = 0;
    this.version = 0;
  }

  fileIdentity(stat) {
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  }

  ingestLine(line) {
    const value = String(line || "").trim();
    if (!value) return;
    try {
      this.records.push(JSON.parse(value));
      if (this.records.length > this.maxRecords) {
        this.records.splice(0, this.records.length - this.maxRecords);
      }
      this.scannedRecords += 1;
      this.version += 1;
    } catch {
      this.malformedLines += 1;
    }
  }

  async consumeRange(start, end) {
    if (end < start) return;
    let text = this.remainder;
    const stream = fs.createReadStream(this.sessionFilePath, { start, end });
    for await (const chunk of stream) {
      text += this.decoder.write(chunk);
      const lines = text.split(/\r?\n/);
      text = lines.pop() || "";
      for (const line of lines) this.ingestLine(line);
    }
    const lines = text.split(/\r?\n/);
    this.remainder = lines.pop() || "";
    for (const line of lines) this.ingestLine(line);
  }

  async rescan(stat = null) {
    const current = stat || await fsp.stat(this.sessionFilePath);
    this.records = [];
    this.offset = 0;
    this.remainder = "";
    this.decoder = new StringDecoder("utf8");
    this.scannedRecords = 0;
    this.malformedLines = 0;
    this.version += 1;
    this.identity = this.fileIdentity(current);
    if (current.size > 0) await this.consumeRange(0, current.size - 1);
    this.offset = current.size;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refreshNow() {
    const stat = await fsp.stat(this.sessionFilePath);
    const identity = this.fileIdentity(stat);
    if (!this.identity || identity !== this.identity || stat.size < this.offset) {
      await this.rescan(stat);
      return;
    }
    if (stat.size > this.offset) {
      await this.consumeRange(this.offset, stat.size - 1);
      this.offset = stat.size;
    }
  }

  snapshot(options) {
    return {
      version: this.version,
      fileName: path.basename(this.sessionFilePath),
      scannedRecords: this.scannedRecords,
      malformedLines: this.malformedLines,
      records: this.records,
      config: {
        pollIntervalMs: options.pollIntervalMs,
        maxMessages: options.maxMessages,
      },
      updatedAt: new Date().toISOString(),
    };
  }
}

function searchableStrings(value, key = "", output = [], depth = 0) {
  if (depth > 24 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    if (!(BINARY_KEY.test(key) || DATA_URL.test(value))) output.push(value);
    return output;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) searchableStrings(item, key, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      searchableStrings(childValue, childKey, output, depth + 1);
    }
  }
  return output;
}

function safeRecord(value, key = "", depth = 0) {
  if (depth > 24) return "[嵌套内容已省略]";
  if (typeof value === "string") {
    if ((BINARY_KEY.test(key) || DATA_URL.test(value)) && value.length > 512) {
      return `[二进制内容已省略，共 ${value.length} 字符]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => safeRecord(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([childKey, childValue]) => [childKey, safeRecord(childValue, childKey, depth + 1)]));
  }
  return value;
}

/** Stream the entire JSONL instead of searching only the in-memory tail. */
export async function searchTranscript(sessionFilePath, query, limit = 100) {
  const needle = String(query || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  if (!needle) throw new Error("请输入搜索内容。");
  if (Array.from(needle).length > 200) throw new Error("搜索内容不能超过 200 个字符。");

  const maximum = boundedInteger(limit, 100, 1, 500, "limit");
  const matches = [];
  let lineNumber = 0;
  let scannedRecords = 0;
  let malformedLines = 0;
  let matchedRecords = 0;
  const input = fs.createReadStream(sessionFilePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    const value = line.trim();
    if (!value) continue;
    let record;
    try {
      record = JSON.parse(value);
      scannedRecords += 1;
    } catch {
      malformedLines += 1;
      continue;
    }
    const haystack = searchableStrings(record).join("\n").normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (!haystack.includes(needle)) continue;
    matchedRecords += 1;
    matches.push({ lineNumber, record: safeRecord(record) });
    if (matches.length > maximum) matches.shift();
  }

  return {
    query: String(query).trim(),
    scannedRecords,
    malformedLines,
    matchedRecords,
    truncated: matchedRecords > matches.length,
    matches,
  };
}

/** Read a bounded section of the original JSONL around one physical line. */
export async function readTranscriptWindow(
  sessionFilePath,
  targetLine,
  before = 100,
  after = 100,
) {
  const target = boundedInteger(targetLine, 0, 1, 2_147_483_647, "line");
  const beforeCount = boundedInteger(before, 100, 0, 500, "before");
  const afterCount = boundedInteger(after, 100, 0, 500, "after");
  const requestedStart = Math.max(1, target - beforeCount);
  const requestedEnd = target + afterCount;
  const records = [];
  let lineNumber = 0;
  let lastLine = 0;
  let malformedLines = 0;
  let targetSeen = false;
  const input = fs.createReadStream(sessionFilePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber < requestedStart) continue;
    if (lineNumber > requestedEnd) break;
    lastLine = lineNumber;
    const value = line.trim();
    if (!value) continue;
    try {
      const record = JSON.parse(value);
      records.push({ lineNumber, record: safeRecord(record) });
      if (lineNumber === target) targetSeen = true;
    } catch {
      malformedLines += 1;
    }
  }
  if (!targetSeen) {
    throw new Error(`JSONL 第 ${target} 行不存在或不是有效记录。`);
  }
  return {
    targetLine: target,
    startLine: requestedStart,
    endLine: lastLine,
    malformedLines,
    records,
  };
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function pageHeaders(length) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": length,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export async function startServer(options = resolveRuntimeOptions()) {
  const tail = new JsonlTail(options.sessionFilePath, options.maxRecords);
  await tail.refresh();
  const viewerPath = path.join(HERE, "viewer.html");

  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET") {
      jsonResponse(res, 405, { error: "只支持 GET。" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/api/session") {
      try {
        await tail.refresh();
        jsonResponse(res, 200, tail.snapshot(options));
      } catch (error) {
        jsonResponse(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/search") {
      try {
        const payload = await searchTranscript(
          options.sessionFilePath,
          url.searchParams.get("q"),
          url.searchParams.get("limit") || 100,
        );
        jsonResponse(res, 200, payload);
      } catch (error) {
        jsonResponse(res, 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/context") {
      try {
        const payload = await readTranscriptWindow(
          options.sessionFilePath,
          url.searchParams.get("line"),
          url.searchParams.get("before") ?? 100,
          url.searchParams.get("after") ?? 100,
        );
        jsonResponse(res, 200, payload);
      } catch (error) {
        jsonResponse(res, 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/viewer.html") {
      try {
        const body = await fsp.readFile(viewerPath);
        res.writeHead(200, pageHeaders(body.length));
        res.end(body);
      } catch {
        jsonResponse(res, 500, { error: "读取 viewer.html 失败。" });
      }
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  return { server, tail };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const options = resolveRuntimeOptions();
    await startServer(options);
    console.log(`会话查看器：http://127.0.0.1:${options.port}`);
    console.log(`会话文件：${options.sessionFilePath}`);
    console.log("仅监听本机。按 Ctrl+C 停止。");
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  }
}
