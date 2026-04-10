import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// Mock embeddings to avoid model download in tests
vi.mock("./embeddings.js", () => {
  // Word-based fake embedding: texts sharing words produce similar vectors
  function fakeEmbedding(text: string): Buffer {
    const dim = 384;
    const floats = new Float32Array(dim);
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      // Hash each word to a deterministic position and add to embedding
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash * 31 + word.charCodeAt(i)) & 0xffff;
      }
      for (let i = 0; i < 8; i++) {
        const idx = (hash + i * 7) % dim;
        floats[idx] += 1.0;
      }
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += floats[i] * floats[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) floats[i] /= norm;
    return Buffer.from(floats.buffer);
  }

  return {
    generateEmbedding: vi.fn(async (text: string) => fakeEmbedding(text)),
    cosineSimilarity: vi.fn((a: Buffer, b: Buffer) => {
      const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
      const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      let dot = 0;
      for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
      return dot;
    }),
  };
});

// Use a fresh temp DB for each test file
process.env.MEMORY_DB_PATH = join(tmpdir(), `memory-test-${randomUUID()}.db`);

import {
  saveFact,
  searchFacts,
  semanticSearch,
  listFacts,
  updateFact,
  deleteFact,
  countFacts,
  getTopFacts,
  backfillEmbeddings,
} from "./repository.js";
import { db } from "./db.js";

beforeEach(() => {
  db.exec(`DELETE FROM fact_relations`);
  db.exec(`DELETE FROM memory_facts`);
  db.exec(
    `INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')`
  );
});

describe("saveFact", () => {
  it("saves a new fact and returns it", async () => {
    const { fact } = await saveFact("User prefers TypeScript", "preference");
    expect(fact.id).toBeGreaterThan(0);
    expect(fact.fact).toBe("User prefers TypeScript");
    expect(fact.category).toBe("preference");
  });

  it("upserts when same fact text exists", async () => {
    const { fact: first } = await saveFact("User likes React", "preference");
    const { fact: second } = await saveFact("User likes React", "technical");
    expect(second.id).toBe(first.id);
    expect(second.category).toBe("technical");
  });

  it("uses 'general' as default category", async () => {
    const { fact } = await saveFact("some info");
    expect(fact.category).toBe("general");
  });

  it("preserves accessCount and lastAccessedAt on upsert", async () => {
    const { fact: first } = await saveFact("Track me", "general");
    // Simulate access
    db.prepare(
      `UPDATE memory_facts SET access_count = 5, last_accessed_at = 12345 WHERE id = ?`
    ).run(first.id);

    const { fact: second } = await saveFact("Track me", "technical");
    expect(second.id).toBe(first.id);
    expect(second.accessCount).toBe(5);
    expect(second.lastAccessedAt).toBe(12345);
  });
});

describe("searchFacts (hybrid)", () => {
  it("finds facts via FTS5", async () => {
    await saveFact("PostgreSQL is the main database", "technical");
    await saveFact("User enjoys hiking on weekends", "personal");

    const results = await searchFacts("database");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fact).toContain("PostgreSQL");
  });

  it("finds facts via semantic when FTS5 misses", async () => {
    await saveFact("I love using React for frontend development", "preference");
    await saveFact("PostgreSQL is our main database", "technical");

    // "frontend framework" won't FTS5-match "React" but semantic should find it
    const results = await searchFacts("frontend framework");
    expect(results.length).toBeGreaterThan(0);
  });

  it("boosts results found by both FTS5 and semantic (RRF)", async () => {
    await saveFact("TypeScript strict mode is required", "decision");
    await saveFact("User enjoys hiking on weekends", "personal");

    // "TypeScript" should match both FTS5 and semantic → ranked highest
    const results = await searchFacts("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fact).toContain("TypeScript");
  });

  it("falls back to LIKE when FTS5 + semantic both empty", async () => {
    // Insert directly without embedding so semantic can't find it
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("NestJS backend framework", "technical", "", now, now);
    db.exec(
      `INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')`
    );

    // Substring "Nest" won't FTS5-MATCH, no embedding → LIKE fallback
    const results = await searchFacts("Nest");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fact).toContain("NestJS");
  });

  it("returns empty array when nothing matches", async () => {
    await saveFact("Something unrelated", "general");
    const results = await searchFacts("xyznonexistent");
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await saveFact(`Fact number ${i}`, "general");
    }
    const results = await searchFacts("Fact", 2);
    expect(results).toHaveLength(2);
  });

  it("increments access_count on search", async () => {
    const { fact: saved } = await saveFact("Track access count", "technical");
    await searchFacts("access");
    await searchFacts("access");

    const facts = listFacts();
    const found = facts.find((f) => f.id === saved.id);
    expect(found!.accessCount).toBe(2);
  });

  it("deduplicates results from FTS5 and semantic", async () => {
    await saveFact("React is a frontend library", "technical");

    const results = await searchFacts("React");
    // Same fact shouldn't appear twice
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("listFacts", () => {
  it("lists all facts", async () => {
    await saveFact("Fact A", "preference");
    await saveFact("Fact B", "technical");
    const all = listFacts();
    expect(all).toHaveLength(2);
  });

  it("filters by category", async () => {
    await saveFact("Fact A", "preference");
    await saveFact("Fact B", "technical");
    const filtered = listFacts("technical");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].category).toBe("technical");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await saveFact(`Fact ${i}`, "general");
    }
    const limited = listFacts(undefined, 3);
    expect(limited).toHaveLength(3);
  });
});

describe("updateFact", () => {
  it("updates fact content", async () => {
    const { fact: saved } = await saveFact("Old content", "general");
    const updated = await updateFact(saved.id, { fact: "New content" });
    expect(updated).not.toBeNull();
    expect(updated!.fact).toBe("New content");
    expect(updated!.category).toBe("general");
  });

  it("updates category only", async () => {
    const { fact: saved } = await saveFact("Keep this text", "general");
    const updated = await updateFact(saved.id, { category: "technical" });
    expect(updated!.fact).toBe("Keep this text");
    expect(updated!.category).toBe("technical");
  });

  it("updates both fact and category", async () => {
    const { fact: saved } = await saveFact("Old", "general");
    const updated = await updateFact(saved.id, {
      fact: "New",
      category: "decision",
    });
    expect(updated!.fact).toBe("New");
    expect(updated!.category).toBe("decision");
  });

  it("returns null for non-existent ID", async () => {
    const result = await updateFact(99999, { fact: "nope" });
    expect(result).toBeNull();
  });

  it("updates FTS5 index after update", async () => {
    const { fact: saved } = await saveFact("Original searchable text", "general");
    await updateFact(saved.id, { fact: "Completely different content" });

    const oldResults = await searchFacts("Original");
    expect(oldResults).toHaveLength(0);

    const newResults = await searchFacts("different");
    expect(newResults).toHaveLength(1);
    expect(newResults[0].fact).toBe("Completely different content");
  });
});

describe("deleteFact", () => {
  it("deletes an existing fact", async () => {
    const { fact: saved } = await saveFact("To be deleted", "general");
    expect(deleteFact(saved.id)).toBe(true);
    expect(countFacts()).toBe(0);
  });

  it("returns false for non-existent ID", () => {
    expect(deleteFact(99999)).toBe(false);
  });

  it("removes from FTS5 index", async () => {
    const { fact: saved } = await saveFact("Searchable content", "general");
    deleteFact(saved.id);
    const results = await searchFacts("Searchable");
    expect(results).toHaveLength(0);
  });
});

describe("semanticSearch", () => {
  it("finds semantically similar facts via embeddings", async () => {
    await saveFact("I love using React for frontend", "preference");
    await saveFact("PostgreSQL is our main database", "technical");

    // Semantic search — fake embeddings produce deterministic similarity
    const results = await semanticSearch("React");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty when no facts have embeddings", async () => {
    // Insert directly without embeddings
    db.prepare(
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("no embedding fact", "general", "", Date.now(), Date.now());

    const results = await semanticSearch("anything");
    expect(results).toHaveLength(0);
  });

  it("filters out low-similarity results below threshold", async () => {
    await saveFact("I love using React for frontend", "preference");

    // Identical query should return results (high similarity)
    const good = await semanticSearch("React frontend");
    expect(good.length).toBeGreaterThan(0);

    // Very different text — fake embeddings should produce low similarity
    // Insert a fact with no word overlap to the query
    db.prepare(
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("zzz_unique_999", "general", "", Date.now(), Date.now(),
      // Zero vector — cosine similarity with any query = 0, below 0.3 threshold
      Buffer.alloc(384 * 4)
    );

    const all = await semanticSearch("React frontend", 100);
    // The zero-vector fact should be filtered out
    expect(all.every((f) => f.fact !== "zzz_unique_999")).toBe(true);
  });
});

describe("backfillEmbeddings", () => {
  it("backfills embeddings for facts without them", async () => {
    // Insert facts without embeddings
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_facts (fact, category, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("fact without embedding", "general", "", now, now);

    const count = await backfillEmbeddings();
    expect(count).toBe(1);

    // Verify embedding was added
    const row = db
      .prepare(`SELECT embedding FROM memory_facts WHERE fact = ?`)
      .get("fact without embedding") as any;
    expect(row.embedding).not.toBeNull();
  });
});

describe("getTopFacts", () => {
  it("returns empty when no facts", () => {
    expect(getTopFacts()).toHaveLength(0);
  });

  it("ranks high-priority categories above general", async () => {
    await saveFact("General info", "general");
    await saveFact("Important preference", "preference");
    await saveFact("Key decision", "decision");

    const top = getTopFacts(10);
    expect(top.length).toBe(3);
    // preference/decision (weight=3) should rank above general (weight=0)
    const categories = top.map((f) => f.category);
    expect(categories.indexOf("general")).toBeGreaterThan(
      categories.indexOf("preference")
    );
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await saveFact(`Fact ${i}`, "general");
    }
    expect(getTopFacts(3)).toHaveLength(3);
  });

  it("boosts frequently accessed facts", async () => {
    await saveFact("Rarely accessed", "general");
    const { fact: popular } = await saveFact("Often accessed", "general");

    // Simulate access
    db.prepare(
      `UPDATE memory_facts SET access_count = 10 WHERE id = ?`
    ).run(popular.id);

    const top = getTopFacts(10);
    expect(top[0].id).toBe(popular.id);
  });
});

describe("countFacts", () => {
  it("returns 0 when empty", () => {
    expect(countFacts()).toBe(0);
  });

  it("returns correct count", async () => {
    await saveFact("A", "general");
    await saveFact("B", "general");
    await saveFact("C", "general");
    expect(countFacts()).toBe(3);
  });
});
