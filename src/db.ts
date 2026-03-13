#!/usr/bin/env node
// db.ts — SQLite connection + schema + FTS5
// DB default: ~/.claude/memory.db (override with MEMORY_DB_PATH env var)

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";

const DB_PATH =
  process.env.MEMORY_DB_PATH || join(homedir(), ".claude", "memory.db");
export const db: DatabaseType = new Database(DB_PATH);

// WAL mode — faster writes
db.pragma("journal_mode = WAL");

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
