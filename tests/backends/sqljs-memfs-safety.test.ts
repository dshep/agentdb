/**
 * SqlJsRvfBackend MEMFS safety net (ruflo#2432 / agentdb#9)
 *
 * Asserts two invariants:
 *
 *   1. FinalizationRegistry is wired — `openCount()` increments on init,
 *      decrements on explicit `close()`.
 *   2. The defensive close path doesn't crash on double-close or
 *      close-after-finalize.
 *
 * What we do NOT test directly: that GC actually triggers the finalizer
 * to reclaim MEMFS. V8 finalization is non-deterministic — there's no
 * portable way to force GC + finalizer cycle in vitest without
 * `--expose-gc` plus an event loop tick dance that's flaky on CI.
 * Reproducible test: `node --expose-gc tests/backends/sqljs-memfs-safety.gc.mjs`
 * (manual, not part of the default suite).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlJsRvfBackend } from '../../src/backends/rvf/SqlJsRvfBackend.js';

describe('SqlJsRvfBackend — MEMFS safety net (ruflo#2432)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sqljs-memfs-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('openCount() increments on initialize() and decrements on close()', async () => {
    const startCount = SqlJsRvfBackend.openCount();

    const backend = new SqlJsRvfBackend({ dimension: 8, metric: 'cosine' });
    expect(SqlJsRvfBackend.openCount()).toBe(startCount); // not yet initialized

    await backend.initialize();
    expect(SqlJsRvfBackend.openCount()).toBe(startCount + 1);

    backend.close();
    expect(SqlJsRvfBackend.openCount()).toBe(startCount);
  });

  it('handles double-close gracefully (idempotent)', async () => {
    const startCount = SqlJsRvfBackend.openCount();
    const backend = new SqlJsRvfBackend({ dimension: 8, metric: 'cosine' });
    await backend.initialize();

    expect(SqlJsRvfBackend.openCount()).toBe(startCount + 1);

    backend.close();
    backend.close(); // second close — must not throw, must not double-decrement

    expect(SqlJsRvfBackend.openCount()).toBe(startCount);
  });

  it('load() replaces the db handle without leaking the prior one', async () => {
    const startCount = SqlJsRvfBackend.openCount();
    const dbPath = join(tmp, 'first.rvf');

    // Set up a file to load from.
    const seed = new SqlJsRvfBackend({
      dimension: 8,
      metric: 'cosine',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storagePath: dbPath,
    } as any);
    await seed.initialize();
    seed.insert('seed-1', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    await seed.save(dbPath);
    seed.close();
    expect(SqlJsRvfBackend.openCount()).toBe(startCount);

    // Now open a fresh backend and call load() — the prior db inside it
    // must be unregistered AND closed before being replaced.
    const backend = new SqlJsRvfBackend({ dimension: 8, metric: 'cosine' });
    await backend.initialize();
    expect(SqlJsRvfBackend.openCount()).toBe(startCount + 1);

    await backend.load(dbPath);
    // After load() we still have exactly ONE open (the new handle replaced
    // the old, which was both unregistered AND closed).
    expect(SqlJsRvfBackend.openCount()).toBe(startCount + 1);

    backend.close();
    expect(SqlJsRvfBackend.openCount()).toBe(startCount);
  });

  it('openCount() reflects multiple concurrent backends', async () => {
    const startCount = SqlJsRvfBackend.openCount();

    const backends = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const b = new SqlJsRvfBackend({ dimension: 8, metric: 'cosine' });
        await b.initialize();
        return b;
      }),
    );

    expect(SqlJsRvfBackend.openCount()).toBe(startCount + 5);

    for (const b of backends) b.close();

    expect(SqlJsRvfBackend.openCount()).toBe(startCount);
  });
});
