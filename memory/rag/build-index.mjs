#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncEmbeddingIndex } from "./embedding.mjs";
import { readEvents } from "./events.mjs";
import { buildMemoryUnits, loadRagConfig, readHistory } from "./retrieve.mjs";

export async function syncIndexFromHistory(configOverride = "", options = {}) {
  const config = loadRagConfig(configOverride);
  const messages = readHistory(config.historyPath);
  const events = readEvents(config.eventsPath);
  const units = buildMemoryUnits(messages, events, config.retrieval.maxTurnGapHours);
  return syncEmbeddingIndex(config.embedding, units, options);
}

async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--rebuild");
  const configArg = argv.find((value) => value.startsWith("--config="));
  const configOverride = configArg ? configArg.slice("--config=".length) : "";
  let lastShown = -1;
  const result = await syncIndexFromHistory(configOverride, {
    force,
    onProgress: ({ completed, total }) => {
      const percent = total ? Math.floor((completed / total) * 100) : 100;
      if (percent === lastShown) return;
      lastShown = percent;
      process.stderr.write(`\r正在生成向量：${completed}/${total} (${percent}%)`);
      if (completed >= total) process.stderr.write("\n");
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`向量索引失败：${error.message}`);
    process.exitCode = 1;
  });
}
