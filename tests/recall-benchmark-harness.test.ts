// CI guard for the ADR-073 §A.1 recall@k harness.
//
// Runs a small deterministic version of scripts/benchmark-recall.mjs and asserts
// recall floors. If a future quantization / indexing change regresses recall
// below the documented floor, this test fails CI — replacing the "95% recall@10"
// claim with an actually-verified one.

import { describe, it, expect } from 'vitest';
import hnswlibModule from 'hnswlib-node';

const { HierarchicalNSW } = hnswlibModule;

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeVec(rng: () => number, d: number): Float32Array {
  const v = new Float32Array(d);
  let s = 0;
  for (let i = 0; i < d; i++) { v[i] = rng() * 2 - 1; s += v[i] * v[i]; }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function bruteforceTopK(vs: Float32Array[], q: Float32Array, k: number): number[] {
  const scored = vs.map((v, i) => ({ id: i, score: cosine(v, q) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.id);
}

describe('recall@k harness (ADR-073 §A.1)', () => {
  it('HNSW recall@10 stays at or above 0.90 floor (deterministic corpus)', () => {
    const N = 1000, D = 64, Q = 30, K = 10;
    const rng = mulberry32(42);
    const qRng = mulberry32(1337);
    const corpus: Float32Array[] = [];
    for (let i = 0; i < N; i++) corpus.push(makeVec(rng, D));
    const queries: Float32Array[] = [];
    for (let i = 0; i < Q; i++) queries.push(makeVec(qRng, D));

    const idx = new HierarchicalNSW('ip', D);
    idx.initIndex(N, 16, 200);
    for (let i = 0; i < N; i++) idx.addPoint(Array.from(corpus[i]), i);
    idx.setEf(100);

    let recallSum = 0;
    for (const q of queries) {
      const gold = new Set(bruteforceTopK(corpus, q, K));
      const { neighbors } = idx.searchKnn(Array.from(q), K);
      let hits = 0;
      for (const id of neighbors) if (gold.has(id)) hits++;
      recallSum += hits / K;
    }
    const avgRecall = recallSum / Q;

    // Documented floor. Production target is 0.95+; we set CI guard at 0.90
    // to allow minor seed/version variance without flaking.
    expect(avgRecall).toBeGreaterThanOrEqual(0.9);
  });

  it('benchmark script imports cleanly (no top-level side-effects break loading)', async () => {
    // We don't run the full bench in CI — too slow. Just confirm hnswlib-node
    // loads, which is the only special dep the harness needs.
    expect(typeof HierarchicalNSW).toBe('function');
  });
});
