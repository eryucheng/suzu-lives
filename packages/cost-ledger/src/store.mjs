import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_PRICE_CATALOG,
  resolveCatalogModel,
} from "./catalog.mjs";
import { normalizeUsage } from "./calculator.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

export function createUsageEvent(input = {}, catalog = DEFAULT_PRICE_CATALOG) {
  const model = clean(input.model);
  const feature = clean(input.feature);
  if (!model) throw new TypeError("model is required");
  if (!feature) throw new TypeError("feature is required");
  const usage = plainObject(input.usage);
  const units = Object.keys(plainObject(input.units)).length
    ? plainObject(input.units)
    : normalizeUsage(model, usage);
  const catalogModel = resolveCatalogModel(catalog, model);
  return {
    schemaVersion: 1,
    id: clean(input.id) || randomUUID(),
    timestamp: validTimestamp(input.timestamp),
    agentId: clean(input.agentId),
    provider: clean(input.provider) || catalogModel?.model?.provider || "",
    model,
    source: clean(input.source) || feature,
    feature,
    requestId: clean(input.requestId),
    usage,
    units: Object.fromEntries(
      Object.entries(units)
        .map(([key, value]) => [key, Number(value)])
        .filter(([, value]) => Number.isFinite(value) && value >= 0),
    ),
    metadata: plainObject(input.metadata),
  };
}

export async function appendUsageEvent(ledgerPath, input, catalog = DEFAULT_PRICE_CATALOG) {
  const destination = path.resolve(ledgerPath);
  const event = createUsageEvent(input, catalog);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.appendFile(destination, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readUsageEvents(ledgerPath, { limit = 50_000 } = {}) {
  const result = {
    status: "missing",
    path: path.resolve(ledgerPath),
    scannedLines: 0,
    malformedLines: 0,
    events: [],
  };
  try {
    if (!(await fsp.stat(result.path)).isFile()) return result;
  } catch {
    return result;
  }

  const input = fs.createReadStream(result.path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const value = line.trim().replace(/^\uFEFF/u, "");
    if (!value) continue;
    result.scannedLines += 1;
    try {
      const event = JSON.parse(value);
      if (event?.schemaVersion === 1 && event.id && event.timestamp && event.model) {
        result.events.push(event);
        if (result.events.length > limit) result.events.shift();
      } else {
        result.malformedLines += 1;
      }
    } catch {
      result.malformedLines += 1;
    }
  }
  result.status = "ready";
  return result;
}
