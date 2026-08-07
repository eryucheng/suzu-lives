#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { createOpenAiCompatibleEmbeddingProvider } from "@suzu-lives/memory-retriever";

import { syncMemoryEmbeddings } from "./index.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function argumentValue(argv, name) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

function argumentValues(argv, name) {
  const prefix = `--${name}=`;
  return argv.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8").replace(/^\uFEFF/u, ""));
}

export async function runMemoryEmbeddingCli(argv = process.argv.slice(2)) {
  const databasePath = argumentValue(argv, "database");
  const agentId = argumentValue(argv, "agent");
  const configPath = argumentValue(argv, "config");
  if (!databasePath || !agentId || !configPath) {
    throw new Error("需要 --database、--agent 和 --config。");
  }
  const source = readJson(configPath);
  const config = source.embedding || source;
  const provider = createOpenAiCompatibleEmbeddingProvider({
    baseUrl: config.baseUrl,
    endpoint: config.endpoint || "embeddings",
    apiKey: config.apiKey,
    apiKeyEnv: config.apiKeyEnv,
    model: config.model,
    dimensions: config.dimensions,
    timeoutMs: config.timeoutMs,
    extraHeaders: config.extraHeaders,
    extraBody: config.extraBody,
  });
  const database = openMemoryDatabase(databasePath);
  try {
    const repository = new MemoryRepository(database);
    return await syncMemoryEmbeddings({
      repository,
      agentId,
      embeddingProvider: provider,
      model: config.model,
      dimensions: config.dimensions,
      ledgerPath: argumentValue(argv, "ledger"),
      batchSize: config.batchSize,
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      memoryIds: argumentValues(argv, "memory-id"),
      limit: argumentValue(argv, "limit") || Number.POSITIVE_INFINITY,
      force: argv.includes("--rebuild"),
      dryRun: argv.includes("--dry-run"),
      continueOnError: !argv.includes("--fail-fast"),
      onProgress: ({ completed, total }) => {
        if (!argv.includes("--quiet")) process.stderr.write(`\r向量化长期记忆：${completed}/${total}`);
      },
    });
  } finally {
    database.close();
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runMemoryEmbeddingCli().then((report) => {
    if (!process.argv.includes("--quiet") && report.pending) process.stderr.write("\n");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "error" || report.status === "partial") process.exitCode = 1;
  }).catch((error) => {
    console.error(`长期记忆向量化失败：${clean(error.message)}`);
    process.exitCode = 1;
  });
}
