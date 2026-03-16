// embeddings.ts — Local semantic embeddings via @xenova/transformers
// Model: all-MiniLM-L6-v2 (384-dim, ~23MB, cached in ~/.cache/huggingface)

import { pipeline, env } from "@xenova/transformers";

// Disable local model check — always use cache/download
env.allowLocalModels = false;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

let extractor: any = null;

async function getExtractor(): Promise<any> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME);
  }
  return extractor;
}

export async function generateEmbedding(text: string): Promise<Buffer> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
  const float32 = new Float32Array(output.data);
  return Buffer.from(float32.buffer);
}

export function cosineSimilarity(a: Buffer, b: Buffer): number {
  const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
  }
  return dot; // normalized vectors → dot product = cosine similarity
}
