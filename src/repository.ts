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

export interface SaveResult {
  fact: MemoryFact;
  relatedLinks: Array<{ id: number; fact: string; similarity: number }>;
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
): Promise<SaveResult> {
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
    const saved: MemoryFact = {
      id: existing.id,
      fact,
      category,
      source,
      createdAt: existing.created_at,
      updatedAt: now,
      lastAccessedAt: existing.last_accessed_at || 0,
      accessCount: existing.access_count || 0,
    };

    // Auto-link related facts
    let relatedLinks: Array<{ id: number; fact: string; similarity: number }> = [];
    if (embedding) {
      relatedLinks = await autoLinkFact(saved.id, embedding);
    }
    return { fact: saved, relatedLinks };
  }

  const result = db
    .prepare(
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(fact, category, source, now, now, embedding);
  const saved: MemoryFact = {
    id: Number(result.lastInsertRowid),
    fact,
    category,
    source,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: 0,
    accessCount: 0,
  };

  // Auto-link related facts
  let relatedLinks: Array<{ id: number; fact: string; similarity: number }> = [];
  if (embedding) {
    relatedLinks = await autoLinkFact(saved.id, embedding);
  }
  return { fact: saved, relatedLinks };
}

/** Link two facts by similarity. Enforces fact_id_1 < fact_id_2. */
function linkFacts(idA: number, idB: number, similarity: number): void {
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  db.prepare(
    `INSERT OR REPLACE INTO fact_relations (fact_id_1, fact_id_2, similarity) VALUES (?, ?, ?)`
  ).run(lo, hi, similarity);
}

/** Delete all relations for a fact (used before recomputing). */
function deleteFactRelations(factId: number): void {
  db.prepare(
    `DELETE FROM fact_relations WHERE fact_id_1 = ? OR fact_id_2 = ?`
  ).run(factId, factId);
}

/** Get related facts for a given fact ID. */
export function getRelatedFacts(factId: number): Array<{ id: number; fact: string; category: string; similarity: number }> {
  const rows = db.prepare(
    `SELECT mf.id, mf.fact, mf.category, fr.similarity
     FROM fact_relations fr
     JOIN memory_facts mf ON mf.id = CASE
       WHEN fr.fact_id_1 = ? THEN fr.fact_id_2
       ELSE fr.fact_id_1
     END
     WHERE fr.fact_id_1 = ? OR fr.fact_id_2 = ?
     ORDER BY fr.similarity DESC`
  ).all(factId, factId, factId) as any[];
  return rows.map(r => ({ id: r.id, fact: r.fact, category: r.category, similarity: r.similarity }));
}

/** Auto-link a fact to its top 3 most similar existing facts (cosine > 0.75). */
async function autoLinkFact(factId: number, factEmbedding: Buffer): Promise<Array<{ id: number; fact: string; similarity: number }>> {
  const rows = db.prepare(
    `SELECT id, fact, embedding FROM memory_facts WHERE id != ? AND embedding IS NOT NULL`
  ).all(factId) as any[];

  const similarities: Array<{ id: number; fact: string; sim: number }> = [];
  for (const row of rows) {
    const sim = cosineSimilarity(factEmbedding, row.embedding as Buffer);
    if (sim > 0.75) {
      similarities.push({ id: row.id, fact: row.fact, sim });
    }
  }

  similarities.sort((a, b) => b.sim - a.sim);
  const top = similarities.slice(0, 3);

  for (const { id, sim } of top) {
    linkFacts(factId, id, sim);
  }

  return top.map(t => ({ id: t.id, fact: t.fact, similarity: t.sim }));
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

  // Recompute relations if embedding changed
  if (updates.fact && updates.fact !== existing.fact && embedding) {
    deleteFactRelations(id);
    await autoLinkFact(id, embedding);
  }

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

export async function backfillRelations(): Promise<number> {
  const rows = db.prepare(
    `SELECT id, embedding FROM memory_facts WHERE embedding IS NOT NULL`
  ).all() as any[];

  if (rows.length < 2) return 0;

  // Compute all pairwise similarities and batch-insert above threshold
  const links: Array<[number, number, number]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = cosineSimilarity(rows[i].embedding as Buffer, rows[j].embedding as Buffer);
      if (sim > 0.75) {
        links.push([rows[i].id, rows[j].id, sim]);
      }
    }
  }

  if (links.length === 0) return 0;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO fact_relations (fact_id_1, fact_id_2, similarity) VALUES (?, ?, ?)`
  );
  const batchInsert = db.transaction((items: Array<[number, number, number]>) => {
    for (const [a, b, sim] of items) {
      insert.run(a, b, sim);
    }
  });
  batchInsert(links);
  return links.length;
}
