#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ragSkipReason } from "../../memory/rag/hook.mjs";
import { loadRagConfig, retrieveMemories } from "../../memory/rag/retrieve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8766;

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

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return { records: [], malformedLines: 0 };
  const records = [];
  let malformedLines = 0;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === "object") records.push({ lineNumber: index + 1, item });
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function historySearchText(item) {
  return [item.timestamp, item.role, item.speaker, item.text, item.id, item.source_uuid]
    .filter((value) => value !== null && value !== undefined)
    .join("\n");
}

function eventSearchText(item) {
  return [
    item.event_date,
    item.source_start_timestamp,
    item.source_end_timestamp,
    item.status,
    item.title,
    item.text,
    item.id,
    ...(Array.isArray(item.source_ids) ? item.source_ids : []),
  ].filter((value) => value !== null && value !== undefined).join("\n");
}

export function searchMemoryStores(config, query, source = "all", limit = 100) {
  const needle = normalize(query).trim();
  if (!needle) throw new Error("请输入搜索内容。");
  if (Array.from(needle).length > 200) throw new Error("搜索内容不能超过 200 个字符。");
  if (!new Set(["all", "history", "events"]).has(source)) throw new Error("未知的搜索范围。");
  const maximum = boundedInteger(limit, 100, 1, 500, "limit");

  const history = readJsonLines(config.historyPath);
  const events = readJsonLines(config.eventsPath);
  const matches = [];
  if (source === "all" || source === "history") {
    for (const record of history.records) {
      if (normalize(historySearchText(record.item)).includes(needle)) {
        matches.push({ source: "history", ...record });
      }
    }
  }
  if (source === "all" || source === "events") {
    for (const record of events.records) {
      if (normalize(eventSearchText(record.item)).includes(needle)) {
        matches.push({ source: "events", ...record });
      }
    }
  }

  matches.sort((left, right) => {
    const leftTime = Date.parse(left.item.timestamp || left.item.source_start_timestamp || "") || 0;
    const rightTime = Date.parse(right.item.timestamp || right.item.source_start_timestamp || "") || 0;
    return rightTime - leftTime;
  });
  return {
    query: String(query).trim(),
    source,
    matchedRecords: matches.length,
    truncated: matches.length > maximum,
    matches: matches.slice(0, maximum),
    stores: {
      history: { records: history.records.length, malformedLines: history.malformedLines },
      events: { records: events.records.length, malformedLines: events.malformedLines },
    },
  };
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function pageHeaders(length) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": length,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

async function readJsonBody(req, maximumBytes = 32 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maximumBytes) throw new Error("请求内容过大。");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("请求不是有效 JSON。");
  }
}

function statusPayload(config) {
  const history = readJsonLines(config.historyPath);
  const events = readJsonLines(config.eventsPath);
  return {
    historyPath: config.historyPath,
    eventsPath: config.eventsPath,
    historyRecords: history.records.length,
    eventRecords: events.records.length,
    malformedHistoryLines: history.malformedLines,
    malformedEventLines: events.malformedLines,
    embedding: {
      enabled: config.embedding.enabled,
      model: config.embedding.model,
    },
  };
}

export async function startServer(options = {}) {
  const port = boundedInteger(options.port, DEFAULT_PORT, 0, 65535, "port");
  const getConfig = () => options.config || loadRagConfig(options.configPath || "");
  const initialConfig = getConfig();
  const viewerPath = path.join(HERE, "viewer.html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      jsonResponse(res, 200, statusPayload(getConfig()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      try {
        const payload = searchMemoryStores(
          getConfig(),
          url.searchParams.get("q"),
          url.searchParams.get("source") || "all",
          url.searchParams.get("limit") || 100,
        );
        jsonResponse(res, 200, payload);
      } catch (error) {
        jsonResponse(res, 400, { error: error.message });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/recall") {
      try {
        const body = await readJsonBody(req);
        const query = String(body.query || "").trim();
        if (!query) throw new Error("请输入要测试的话。");
        if (Array.from(query).length > 1000) throw new Error("测试内容不能超过 1000 个字符。");
        const hookSkipReason = ragSkipReason(query);
        const config = getConfig();
        const result = hookSkipReason
          ? {
            query,
            recallIntent: "not-run",
            skippedReason: `hook-${hookSkipReason}`,
            historyMessages: 0,
            eventMemories: 0,
            searchedUnits: 0,
            retrievalMode: "skipped-by-hook",
            eventFallbackUsed: false,
            vector: { status: "not-run" },
            fragments: [],
            context: "",
          }
          : await retrieveMemories(query, config);
        jsonResponse(res, 200, result);
      } catch (error) {
        jsonResponse(res, 400, { error: error.message });
      }
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/viewer.html")) {
      try {
        const body = await fsp.readFile(viewerPath);
        res.writeHead(200, pageHeaders(body.length));
        res.end(body);
      } catch {
        jsonResponse(res, 500, { error: "读取 viewer.html 失败。" });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!["GET", "POST"].includes(req.method || "")) {
      jsonResponse(res, 405, { error: "不支持该请求方法。" });
      return;
    }
    jsonResponse(res, 404, { error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, config: initialConfig, port: actualPort };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const port = optionValue(process.argv.slice(2), "--port") || DEFAULT_PORT;
    const configPath = optionValue(process.argv.slice(2), "--config") || "";
    const started = await startServer({ port, configPath });
    console.log(`记忆查看器：http://127.0.0.1:${started.port}`);
    console.log(`history：${started.config.historyPath}`);
    console.log(`events：${started.config.eventsPath}`);
    console.log("仅监听本机。按 Ctrl+C 停止。");
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  }
}
