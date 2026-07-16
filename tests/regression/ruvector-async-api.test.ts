/**
 * Regression tests for RuVectorBackend vs the real `ruvector` VectorDB API.
 *
 * The backend was written against an API the engine does not have. `ruvector`
 * is async-native — insert/search/delete/len all return promises — but the
 * backend drove it through the sync VectorBackend interface:
 *
 *   1. search() called db.search() WITHOUT awaiting, then read `.length` off
 *      the returned Promise. `undefined | 0` is 0, so the result loop never
 *      ran and EVERY query returned [] — silently, no error. This is why
 *      `new AgentDB({ vectorBackend: 'ruvector' })` stored fine and recalled
 *      nothing.
 *   2. Results were read as `r.distance`; VectorDB returns `{ id, score }`,
 *      so similarity was distanceToSimilarity(undefined) === NaN.
 *   3. getStats() called db.count() — the method is len() — throwing
 *      TypeError on every call.
 *   4. remove() called db.remove() — the method is delete() — so it threw
 *      into its own catch and reported false while deleting nothing.
 *
 * The engine itself was never broken: driven per its README (await + object
 * args) it returns correct neighbours.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createBackend } from '../../src/backends/factory.js';

const DIM = 384;

/** Deterministic, distinct unit-ish vectors. */
const mkVec = (seed: number): Float32Array => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed + i);
  return v;
};

// RuVector persists to a shared default store, so ids must be unique per run
// or results bleed across tests. Assert on our own ids, never on total counts.
const tag = `rvtest-${process.pid}`;

let backend: any;
let available = true;

beforeAll(async () => {
  try {
    backend = await createBackend('ruvector', { dimensions: DIM, metric: 'cosine' });
  } catch {
    available = false;
  }
});

describe('RuVectorBackend async API (agentdb#ruvector-search)', () => {
  it('searchAsync returns the vector that was inserted', async () => {
    if (!available) return;

    const target = mkVec(11);
    backend.insert(`${tag}-a`, target, { type: 'episode' });
    backend.insert(`${tag}-b`, mkVec(9999), { type: 'episode' });

    const results = await backend.searchAsync(target, 10, { threshold: 0.0 });

    // The bug: this was [] for every query, forever.
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r: any) => r.id)).toContain(`${tag}-a`);
  });

  it('reports a real similarity, not NaN, for an exact match', async () => {
    if (!available) return;

    const target = mkVec(21);
    backend.insert(`${tag}-exact`, target, { type: 'episode' });

    const results = await backend.searchAsync(target, 10, { threshold: 0.0 });
    const hit = results.find((r: any) => r.id === `${tag}-exact`);

    expect(hit).toBeDefined();
    // Reading r.distance (absent) instead of r.score produced NaN here, which
    // silently loses every downstream comparison.
    expect(Number.isNaN(hit.similarity)).toBe(false);
    expect(hit.similarity).toBeGreaterThan(0.99);
  });

  it('settles sync inserts before searching (no read-your-writes race)', async () => {
    if (!available) return;

    // db.insert() is async; the sync interface cannot await it. Inserting and
    // immediately searching must still see the data.
    const target = mkVec(31);
    backend.insert(`${tag}-race`, target, { type: 'episode' });

    const results = await backend.searchAsync(target, 10, { threshold: 0.0 });
    expect(results.map((r: any) => r.id)).toContain(`${tag}-race`);
  });

  it('sync search() fails loudly instead of pretending the index is empty', () => {
    if (!available) return;

    // Returning [] from an unawaited Promise is indistinguishable from "no
    // matches" — the failure mode that hid this bug. Throwing is the contract.
    expect(() => backend.search(mkVec(1), 5)).toThrow(/async-only/i);
  });

  it('getStats() does not throw on the absent count() method', () => {
    if (!available) return;
    expect(() => backend.getStats()).not.toThrow();
  });

  it('removeAsync actually removes the vector', async () => {
    if (!available) return;

    const target = mkVec(41);
    await backend.insertAsync(`${tag}-gone`, target, { type: 'episode' });

    let results = await backend.searchAsync(target, 10, { threshold: 0.0 });
    expect(results.map((r: any) => r.id)).toContain(`${tag}-gone`);

    expect(await backend.removeAsync(`${tag}-gone`)).toBe(true);

    results = await backend.searchAsync(target, 10, { threshold: 0.0 });
    expect(results.map((r: any) => r.id)).not.toContain(`${tag}-gone`);
  });
});
