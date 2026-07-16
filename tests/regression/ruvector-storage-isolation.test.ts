/**
 * Regression tests for RuVector index isolation and backend detection.
 *
 * 1. Storage isolation — RuVectorBackend never passed `storagePath`, so every
 *    VectorDB fell back to the engine default: a single './ruvector.db' in the
 *    process CWD. Every AgentDB database in every process shared it, so one
 *    database's vectors surfaced in another's search results (reproduced
 *    cross-process: a fresh database returned 'SECRET-from-process-1'). The
 *    index is now derived from the owning database's path, and an index with
 *    nowhere to anchor gets a private scratch file instead of the shared one.
 *
 * 2. Detection — checkRuVector() probed @ruvector/core for isNative()/version,
 *    neither of which it exposes, so it reported "Native: ❌ (using WASM)" and
 *    "Version: unknown" unconditionally. The package actually loaded is
 *    `ruvector`, which exposes both; the engine was native the whole time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBackend } from '../../src/backends/factory.js';
import { detectBackend } from '../../src/backends/detector.js';

const DIM = 384;
const mkVec = (seed: number): Float32Array => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed + i);
  return v;
};

const mkBackend = async (storagePath?: string): Promise<any> =>
  createBackend('ruvector', { dimensions: DIM, metric: 'cosine', storagePath });

const tmpDirs: string[] = [];
const newTmpDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-rv-iso-'));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('RuVector index isolation (shared-store leak)', () => {
  it('does not create a shared default index in the process CWD', async () => {
    const cwdDefault = path.join(process.cwd(), 'ruvector.db');
    const existedBefore = fs.existsSync(cwdDefault);

    const backend = await mkBackend();
    await backend.insertAsync('iso-a', mkVec(3), { type: 'episode' });

    // The bug: constructing any RuVector backend dropped a shared
    // './ruvector.db' here, which every other database then read from.
    if (!existedBefore) {
      expect(fs.existsSync(cwdDefault)).toBe(false);
    }
    backend.close?.();
  });

  it('keeps two databases with different storage paths isolated', async () => {
    const dir = newTmpDir();

    const a = await mkBackend(path.join(dir, 'a.vectors'));
    await a.insertAsync('SECRET-from-a', mkVec(7), { owner: 'a' });
    await a.flush();

    // b is constructed AFTER a's write — under the shared default it would
    // load a's persisted vectors at construction time.
    const b = await mkBackend(path.join(dir, 'b.vectors'));
    const results = await b.searchAsync(mkVec(7), 10, { threshold: 0.0 });

    expect(results.map((r: any) => r.id)).not.toContain('SECRET-from-a');
  });

  it('persists an index to its configured path across instances', async () => {
    const dir = newTmpDir();
    const storagePath = path.join(dir, 'persist.vectors');

    const first = await mkBackend(storagePath);
    await first.insertAsync('durable-1', mkVec(13), { type: 'episode' });
    await first.flush();
    first.close?.();

    // Isolation must not cost persistence: a new instance on the same path
    // still sees the data.
    const second = await mkBackend(storagePath);
    const results = await second.searchAsync(mkVec(13), 10, { threshold: 0.0 });
    expect(results.map((r: any) => r.id)).toContain('durable-1');
  });

  it('removes its private scratch index on close()', async () => {
    const backend = await mkBackend(); // no path -> ephemeral
    await backend.insertAsync('temp-1', mkVec(17), { type: 'episode' });

    const scratch: string | null = (backend as any).ephemeralStoragePath;
    expect(scratch).toBeTruthy();

    backend.close();
    expect(fs.existsSync(scratch!)).toBe(false);
  });
});

describe('RuVector detection probes the loaded package', () => {
  it('reports native bindings and a real version, not unknown', async () => {
    const result = await detectBackend();
    if (result.backend !== 'ruvector') return; // ruvector not installed here

    // Probing @ruvector/core (which exposes neither) pinned these to
    // false/'unknown' regardless of what was actually running.
    expect(result.native).toBe(true);
    expect(result.versions?.core).not.toBe('unknown');
    expect(result.versions?.core).toMatch(/^\d+\.\d+\.\d+/);
  });
});
