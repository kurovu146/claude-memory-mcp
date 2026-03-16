// repository.ts — Memory CRUD + FTS5 + Semantic search

import { db } from "./db.js";
import { generateEmbedding, cosineSimilarity } from "./embeddings.js";

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

export async function saveFact(
  fact: string,
  category = "general",
  source = ""
): Promise<MemoryFact> {
  const now = Date.now();

  // Generate embedding
  let embedding: Buffer | null = null;
  try {
    embedding = await generateEmbedding(fact);
  } catch {
    // Embedding generation failed — save without it
  }

  // Upsert: skip if exact same fact already exists
  const existing = db
    .prepare(`SELECT id FROM memory_facts WHERE fact = ?`)
    .get(fact) as any;

  if (existing) {
    db.prepare(
      `UPDATE memory_facts SET category = ?, source = ?, updated_at = ?, embedding = ? WHERE id = ?`
    ).run(category, source, now, embedding, existing.id);
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
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(fact, category, source, now, now, embedding);
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

export async function searchFacts(
  keyword: string,
  limit = 10
): Promise<MemoryFact[]> {
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
    const facts = likeRows.map(mapFact);
    touchAccess(facts.map((f) => f.id));
    return facts;
  }

  // Semantic search fallback — vector similarity
  return semanticSearch(keyword, limit);
}

export async function semanticSearch(
  query: string,
  limit = 10
): Promise<MemoryFact[]> {
  let queryEmbedding: Buffer;
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch {
    return []; // Model not available — no semantic results
  }

  // Load all facts that have embeddings
  const rows = db
    .prepare(`SELECT * FROM memory_facts WHERE embedding IS NOT NULL`)
    .all() as any[];

  if (rows.length === 0) return [];

  // Compute cosine similarity and rank
  const scored = rows
    .map((row) => ({
      row,
      score: cosineSimilarity(queryEmbedding, row.embedding as Buffer),
    }))
    .filter((s) => s.score > 0.3) // threshold to avoid noise
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length > 0) {
    const facts = scored.map((s) => mapFact(s.row));
    touchAccess(facts.map((f) => f.id));
    return facts;
  }

  return [];
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

export async function updateFact(
  id: number,
  updates: { fact?: string; category?: string }
): Promise<MemoryFact | null> {
  const existing = db
    .prepare(`SELECT * FROM memory_facts WHERE id = ?`)
    .get(id) as any;
  if (!existing) return null;

  const newFact = updates.fact ?? existing.fact;
  const newCategory = updates.category ?? existing.category;
  const now = Date.now();

  // Regenerate embedding if fact text changed
  let embedding = existing.embedding;
  if (updates.fact && updates.fact !== existing.fact) {
    try {
      embedding = await generateEmbedding(newFact);
    } catch {
      // Keep existing embedding on failure
    }
  }

  db.prepare(
    `UPDATE memory_facts SET fact = ?, category = ?, updated_at = ?, embedding = ? WHERE id = ?`
  ).run(newFact, newCategory, now, embedding, id);

  return mapFact({
    ...existing,
    fact: newFact,
    category: newCategory,
    updated_at: now,
  });
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

export async function backfillEmbeddings(): Promise<number> {
  const rows = db
    .prepare(`SELECT id, fact FROM memory_facts WHERE embedding IS NULL`)
    .all() as any[];

  let count = 0;
  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(row.fact);
      db.prepare(`UPDATE memory_facts SET embedding = ? WHERE id = ?`).run(
        embedding,
        row.id
      );
      count++;
    } catch {
      // Skip facts that fail to embed
    }
  }
  return count;
}
