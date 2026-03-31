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
    .prepare(`SELECT * FROM memory_facts WHERE fact = ?`)
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
      createdAt: existing.created_at,
      updatedAt: now,
      lastAccessedAt: existing.last_accessed_at || 0,
      accessCount: existing.access_count || 0,
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

/**
 * Hybrid search: chạy FTS5 + semantic song song, merge bằng Reciprocal Rank Fusion.
 * Fallback LIKE chỉ khi cả 2 đều trả về 0.
 */
export async function searchFacts(
  query: string,
  limit = 10
): Promise<MemoryFact[]> {
  const candidatePool = limit * 3;

  // Run FTS5 and semantic in parallel (skip access tracking — done after merge)
  const [ftsResults, semResults] = await Promise.all([
    ftsSearch(query, candidatePool),
    semanticSearch(query, candidatePool, { trackAccess: false }),
  ]);

  // Both empty → LIKE fallback
  if (ftsResults.length === 0 && semResults.length === 0) {
    return likeFallback(query, limit);
  }

  // Merge with RRF
  const merged = mergeWithRRF(ftsResults, semResults, limit);
  touchAccess(merged.map((f) => f.id));
  return merged;
}

/** FTS5 + BM25 keyword search */
function ftsSearch(query: string, limit: number): MemoryFact[] {
  try {
    const rows = db
      .prepare(
        `SELECT m.*
       FROM memory_facts_fts fts
       JOIN memory_facts m ON m.id = fts.rowid
       WHERE memory_facts_fts MATCH ?
       ORDER BY bm25(memory_facts_fts)
       LIMIT ?`
      )
      .all(query, limit) as any[];
    return rows.map(mapFact);
  } catch {
    // FTS5 MATCH can throw on invalid syntax — fall through
    return [];
  }
}

/** LIKE fallback for partial/substring matches */
function likeFallback(query: string, limit: number): MemoryFact[] {
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = db
    .prepare(
      `SELECT * FROM memory_facts
     WHERE fact LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
     ORDER BY updated_at DESC LIMIT ?`
    )
    .all(`%${escaped}%`, `%${escaped}%`, limit) as any[];
  const facts = rows.map(mapFact);
  if (facts.length > 0) touchAccess(facts.map((f) => f.id));
  return facts;
}

/**
 * Reciprocal Rank Fusion — merge 2 ranked lists.
 * score(d) = Σ 1/(k + rank_i) for each list where d appears.
 * k=60 is standard. Documents in both lists get naturally boosted.
 */
function mergeWithRRF(
  listA: MemoryFact[],
  listB: MemoryFact[],
  limit: number,
  k = 60
): MemoryFact[] {
  const scores = new Map<number, { score: number; fact: MemoryFact }>();

  for (let i = 0; i < listA.length; i++) {
    const f = listA[i];
    const entry = scores.get(f.id) || { score: 0, fact: f };
    entry.score += 1 / (k + i + 1);
    scores.set(f.id, entry);
  }

  for (let i = 0; i < listB.length; i++) {
    const f = listB[i];
    const entry = scores.get(f.id) || { score: 0, fact: f };
    entry.score += 1 / (k + i + 1);
    scores.set(f.id, entry);
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.fact);
}

/** Semantic vector search — cosine similarity on embeddings */
export async function semanticSearch(
  query: string,
  limit = 10,
  { trackAccess = true }: { trackAccess?: boolean } = {}
): Promise<MemoryFact[]> {
  let queryEmbedding: Buffer;
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch {
    return []; // Model not available — no semantic results
  }

  const rows = db
    .prepare(`SELECT * FROM memory_facts WHERE embedding IS NOT NULL`)
    .all() as any[];

  if (rows.length === 0) return [];

  const results = rows
    .map((row) => ({
      fact: mapFact(row),
      score: cosineSimilarity(queryEmbedding, row.embedding as Buffer),
    }))
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.fact);

  if (trackAccess && results.length > 0)
    touchAccess(results.map((f) => f.id));
  return results;
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

const CATEGORY_WEIGHT: Record<string, number> = {
  preference: 3,
  decision: 3,
  workflow: 2,
  technical: 2,
  project: 1,
  personal: 1,
  general: 0,
};

/** Top N facts ranked by importance = access frequency + recency + category weight */
export function getTopFacts(limit = 30): MemoryFact[] {
  const rows = db
    .prepare(`SELECT * FROM memory_facts ORDER BY updated_at DESC`)
    .all() as any[];

  if (rows.length === 0) return [];

  const now = Date.now();
  const DAY_MS = 86_400_000;

  return rows
    .map((row) => {
      const fact = mapFact(row);
      const daysSinceUpdate = (now - fact.updatedAt) / DAY_MS;
      // Recency: 10 points for today, decays over 90 days
      const recency = Math.max(0, 10 * (1 - daysSinceUpdate / 90));
      const access = Math.min(fact.accessCount * 2, 20); // cap at 20
      const catWeight = CATEGORY_WEIGHT[fact.category] ?? 0;
      const score = access + recency + catWeight;
      return { fact, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.fact);
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
