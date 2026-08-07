import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, SCHEMA_VERSION } from "./schema.mjs";

function isoNow() {
  return new Date().toISOString();
}

function applyMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all()
      .map((row) => Number(row.version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, isoNow());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createSearchTable(database) {
  const existing = database.prepare(
    "SELECT value FROM memory_meta WHERE key = 'search_tokenizer'",
  ).get();
  if (existing?.value) return existing.value;

  let tokenizer = "trigram";
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        agent_id UNINDEXED,
        title,
        content,
        tokenize = 'trigram'
      );
    `);
  } catch {
    tokenizer = "unicode61";
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        agent_id UNINDEXED,
        title,
        content,
        tokenize = 'unicode61'
      );
    `);
  }

  database.prepare(`
    INSERT INTO memory_meta (key, value) VALUES ('search_tokenizer', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(tokenizer);
  return tokenizer;
}

export function openMemoryDatabase(databasePath = ":memory:", {
  readOnly = false,
  timeout = 5000,
} = {}) {
  const fileBacked = databasePath !== ":memory:";
  if (fileBacked && !readOnly) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new DatabaseSync(databasePath, {
    readOnly,
    timeout,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeout))}`);

  if (!readOnly) {
    if (fileBacked) database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    applyMigrations(database);
    createSearchTable(database);
  }

  return database;
}

export function databaseInfo(database) {
  const version = database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get();
  const tokenizer = database.prepare(
    "SELECT value FROM memory_meta WHERE key = 'search_tokenizer'",
  ).get();
  return {
    schemaVersion: Number(version?.version || 0),
    expectedSchemaVersion: SCHEMA_VERSION,
    searchTokenizer: tokenizer?.value || "",
  };
}
