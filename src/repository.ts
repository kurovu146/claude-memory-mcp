// repository.ts — Memory CRUD + FTS5 search

import { db } from "./db.js";

export interface MemoryFact {
  id: number;
  fact: string;
  category: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

function mapFact(r: any): MemoryFact {
  return {
    id: r.id,
    fact: r.fact,
    category: r.category,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at || 0,
    accessCount: r.access_count || 0,
  };
}

function touchAccess(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE memory_facts SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id IN (${placeholders})`
  ).run(Date.now(), ...ids);
}

export function saveFact(
  fact: string,
  category = "general",
  source = ""
): MemoryFact {
  const now = Date.now();

  // Upsert: skip if exact same fact already exists
  const existing = db
    .prepare(`SELECT id FROM memory_facts WHERE fact = ?`)
    .get(fact) as any;

  if (existing) {
    db.prepare(
      `UPDATE memory_facts SET category = ?, source = ?, updated_at = ? WHERE id = ?`
    ).run(category, source, now, existing.id);
    return {
      id: existing.id,
      fact,
      category,
      source,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: 0,
      accessCount: 0,
    };
  }

  const result = db
    .prepare(
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
    )
    .run(fact, category, source, now, now);
  return {
    id: Number(result.lastInsertRowid),
    fact,
    category,
    source,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: 0,
    accessCount: 0,
  };
}

export function searchFacts(keyword: string, limit = 10): MemoryFact[] {
  // FTS5 BM25 ranking
  const ftsRows = db
    .prepare(
      `SELECT m.*, bm25(memory_facts_fts) as rank
     FROM memory_facts_fts fts
     JOIN memory_facts m ON m.id = fts.rowid
     WHERE memory_facts_fts MATCH ?
     ORDER BY rank
     LIMIT ?`
    )
    .all(keyword, limit) as any[];

  if (ftsRows.length > 0) {
    const facts = ftsRows.map(mapFact);
    touchAccess(facts.map((f) => f.id));
    return facts;
  }

  // LIKE fallback for partial matches
  const likeRows = db
    .prepare(
      `SELECT * FROM memory_facts
     WHERE fact LIKE ? OR category LIKE ?
     ORDER BY updated_at DESC LIMIT ?`
    )
    .all(`%${keyword}%`, `%${keyword}%`, limit) as any[];

  if (likeRows.length > 0) {
    touchAccess(likeRows.map((r: any) => r.id));
  }
  return likeRows.map(mapFact);
}

export function listFacts(
  category?: string,
  limit = 50
): MemoryFact[] {
  if (category) {
    return (
      db
        .prepare(
          `SELECT * FROM memory_facts WHERE category = ? ORDER BY updated_at DESC LIMIT ?`
        )
        .all(category, limit) as any[]
    ).map(mapFact);
  }
  return (
    db
      .prepare(
        `SELECT * FROM memory_facts ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as any[]
  ).map(mapFact);
}

export function deleteFact(id: number): boolean {
  const result = db
    .prepare(`DELETE FROM memory_facts WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

export function countFacts(): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM memory_facts`)
    .get() as any;
  return row.cnt;
}
