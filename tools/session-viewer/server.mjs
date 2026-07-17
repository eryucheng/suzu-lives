#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = Object.freeze({
  port: 8765,
  pollIntervalMs: 2000,
  maxMessages: 500,
  maxRecords: 2500,
});

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
