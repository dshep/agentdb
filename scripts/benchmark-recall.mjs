#!/usr/bin/env node
// benchmark-recall.mjs — recall@k harness for HNSW vs brute-force (ADR-073 §A.1).
//
// Replaces "95% recall@10" / "36% recall uplift" / "32x memory reduction"
// claims-without-measurement with a deterministic, committed run JSON that any
// future change can be compared against. Uses the SAME hnswlib-node primitive
// agentdb's HNSWIndex wraps, with the SAME defaults (M=16, efConstruction=200,
// efSearch=100), so the numbers are valid for the live code path.
//
// Usage:
//   node scripts/benchmark-recall.mjs            # default 2000 vec / 50 queries
//   N=5000 Q=100 D=384 K=10 node scripts/benchmark-recall.mjs

import hnswlibModule from 'hnswlib-node';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const { HierarchicalNSW } = hnswlibModule;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, '..');
const RUNS_DIR = join(PKG_ROOT, 'docs', 'benchmarks', 'runs');

const N = Number(process.env.N) || 2000;
const Q = Number(process.env.Q) || 50;
const D = Number(process.env.D) || 384;
const KS = [1, 10, 100];
const M = 16;
const EF_CONSTRUCTION = 200;
const EF_SEARCH = 100;

// Mulberry32 — small, deterministic PRNG so the corpus is reproducible.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeVec(rng, d) {
  const v = new Float32Array(d);
  let s = 0;
  for (let i = 0; i < d; i++) { v[i] = rng() * 2 - 1; s += v[i] * v[i]; }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < d; i++) v[i] /= n; // L2 normalize → cosine == dot
  return v;
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function bruteforceTopK(vectors, q, k) {
  const scored = vectors.map((v, i) => ({ id: i, score: cosine(v, q) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.id);
}

async function main() {
  console.log(`# Recall@k benchmark — N=${N} D=${D} Q=${Q} M=${M} efC=${EF_CONSTRUCTION} efS=${EF_SEARCH}`);

  const rng = mulberry32(42);
  const queryRng = mulberry32(1337);

  // 1. Build corpus + queries.
  const corpus = [];
  for (let i = 0; i < N; i++) corpus.push(makeVec(rng, D));
  const queries = [];
  for (let q = 0; q < Q; q++) queries.push(makeVec(queryRng, D));

  // 2. Build the HNSW index using cosine via inner product (vectors are L2-normalised).
  const index = new HierarchicalNSW('ip', D);
  index.initIndex(N, M, EF_CONSTRUCTION);
  // hnswlib-node addPoint takes a regular Array, not Float32Array.
  const asArray = (v) => Array.from(v);
  const tBuild0 = performance.now();
  for (let i = 0; i < N; i++) index.addPoint(asArray(corpus[i]), i);
  const buildMs = performance.now() - tBuild0;
  index.setEf(EF_SEARCH);

  // 3. For each query: brute-force gold @ max(KS), then HNSW @ each k, compute recall + latency.
  const kmax = Math.max(...KS);
  const recallSums = Object.fromEntries(KS.map((k) => [k, 0]));
  const annLatencies = [];

  for (const q of queries) {
    const gold = new Set(bruteforceTopK(corpus, q, kmax));
    const qArr = Array.from(q);
    const t0 = performance.now();
    const { neighbors } = index.searchKnn(qArr, kmax);
    annLatencies.push(performance.now() - t0);
    for (const k of KS) {
      const ann = new Set(neighbors.slice(0, k));
      const goldK = new Set(bruteforceTopK(corpus, q, k));
      let hits = 0;
      for (const id of ann) if (goldK.has(id)) hits++;
      recallSums[k] += hits / k;
    }
  }

  const recallAtK = Object.fromEntries(KS.map((k) => [`recall_at_${k}`, Number((recallSums[k] / Q).toFixed(4))]));
  annLatencies.sort((a, b) => a - b);
  const p = (q) => annLatencies[Math.min(annLatencies.length - 1, Math.floor(q * annLatencies.length))];

  const summary = {
    runAt: new Date().toISOString(),
    benchmark: 'recall-hnsw',
    config: { N, D, Q, K: KS, M, efConstruction: EF_CONSTRUCTION, efSearch: EF_SEARCH },
    buildMs: Number(buildMs.toFixed(2)),
    ...recallAtK,
    annLatencyMs: {
      avg: Number((annLatencies.reduce((s, x) => s + x, 0) / annLatencies.length).toFixed(4)),
      p50: Number(p(0.5).toFixed(4)),
      p99: Number(p(0.99).toFixed(4)),
      max: Number(annLatencies[annLatencies.length - 1].toFixed(4)),
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!process.env.BENCH_NO_WRITE) {
    mkdirSync(RUNS_DIR, { recursive: true });
    const stamp = summary.runAt.replace(/[:.]/g, '-');
    const out = { summary, queries: Q };
    writeFileSync(join(RUNS_DIR, `recall-${stamp}.json`), JSON.stringify(out, null, 2));
    writeFileSync(join(RUNS_DIR, 'recall-latest.json'), JSON.stringify(out, null, 2));
    console.log(`Wrote ${join(RUNS_DIR, `recall-${stamp}.json`)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
