#!/usr/bin/env node
// db.ts — SQLite connection + schema + FTS5
// DB default: ~/.claude/memory.db (override with MEMORY_DB_PATH env var)

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

// Safety guard: refuse to open the production DB from a Vitest run.
// vitest auto-sets VITEST=true in every worker. If a test forgets to override
// MEMORY_DB_PATH (e.g. via src/test-setup.ts), the `beforeEach` DELETE hooks
// in repository.test.ts would wipe ~/.claude/memory.db. Throw instead so the
// failure is loud and user memories stay safe.
if (process.env.VITEST === "true" && !process.env.MEMORY_DB_PATH) {
  throw new Error(
    "[claude-memory-fts] Refusing to open production DB inside Vitest. " +
      "Set MEMORY_DB_PATH to an isolated path before db.js is imported " +
      "(see src/test-setup.ts).",
  );
}

const DB_PATH =
  process.env.MEMORY_DB_PATH || join(homedir(), ".claude", "memory.db");

// Ensure parent directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);

// WAL mode — faster writes
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_facts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fact           TEXT    NOT NULL,
    category       TEXT    NOT NULL DEFAULT 'general',
    source         TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    access_count   INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_memory_facts_category
  ON memory_facts (category)
`);

// --- FTS5 full-text search ---

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
    fact, category,
    content='memory_facts',
    content_rowid='id'
  )
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(rowid, fact, category)
    VALUES (new.id, new.fact, new.category);
  END
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, category)
    VALUES ('delete', old.id, old.fact, old.category);
  END
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact, category)
    VALUES ('delete', old.id, old.fact, old.category);
    INSERT INTO memory_facts_fts(rowid, fact, category)
    VALUES (new.id, new.fact, new.category);
  END
`);

db.exec(
  `INSERT OR IGNORE INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')`
);

// --- Migration: add embedding column for semantic search ---

const columns = db.pragma("table_info(memory_facts)") as any[];
if (!columns.some((c: any) => c.name === "embedding")) {
  db.exec(`ALTER TABLE memory_facts ADD COLUMN embedding BLOB`);
}

// --- Migration: add fact_relations table for semantic linking ---

db.exec(`
  CREATE TABLE IF NOT EXISTS fact_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id_1 INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    fact_id_2 INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(fact_id_1, fact_id_2),
    CHECK(fact_id_1 < fact_id_2)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_fact_relations_1 ON fact_relations(fact_id_1)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_fact_relations_2 ON fact_relations(fact_id_2)`);
