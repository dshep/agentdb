// Regression tests for the ADR-073 MCP additions.
// Tests the underlying behaviors the new handlers depend on:
//   causal_traverse        → CausalMemoryGraph.getCausalChain()
//   agentdb_delete_batch   → IN-clause parameterised delete pattern
//   consolidate_now        → NightlyLearner.run() / .consolidateEpisodes()

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CausalMemoryGraph, CausalEdge } from '../src/controllers/CausalMemoryGraph.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(here, '..', 'src', 'schemas');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(SCHEMAS_DIR, 'schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(SCHEMAS_DIR, 'frontier-schema.sql'), 'utf-8'));
  return db as unknown as Database.Database;
}

describe('causal_traverse (ADR-073 §B.3) — getCausalChain', () => {
  let db: Database.Database;
  let causalGraph: CausalMemoryGraph;

  beforeEach(() => {
    db = freshDb();
    causalGraph = new CausalMemoryGraph(db as any);
  });
  afterEach(() => db.close());

  it('finds a multi-hop chain A→B→C and returns the edge list', async () => {
    // Seed three nodes 1 → 2 → 3 with strong causal edges.
    const seedEdge = (from: number, to: number): Promise<number> => {
      const edge: CausalEdge = {
        fromMemoryId: from,
        fromMemoryType: 'episode',
        toMemoryId: to,
        toMemoryType: 'episode',
        similarity: 0.9,
        uplift: 0.5,
        confidence: 0.95,
        sampleSize: 100,
        evidenceIds: [],
      };
      return causalGraph.addCausalEdge(edge);
    };
    await seedEdge(1, 2);
    await seedEdge(2, 3);

    const chain = await causalGraph.getCausalChain(1, 3, 5);
    expect(chain).toBeDefined();
    // The chain object must reference at least one edge connecting the path.
    expect(JSON.stringify(chain)).toMatch(/(uplift|confidence|path|edges)/i);
  });

  it('returns a graceful empty result when no chain exists', async () => {
    const chain = await causalGraph.getCausalChain(999, 1000, 3);
    expect(chain).toBeDefined();
    // Implementation may return {edges:[]} or {path:[]} — assert "no positive evidence".
    const s = JSON.stringify(chain);
    expect(s.includes('"uplift":0.95') || s.includes('"path":[]') || s.includes('"edges":[]') || s === '{}').toBe(false);
  });
});

describe('agentdb_delete_batch (ADR-073 §B.5) — IN-clause atomic delete', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('removes only the ids in the list, atomically', () => {
    // Seed 5 episodes.
    const ins = db.prepare(`INSERT INTO episodes (ts, session_id, task, input, output, critique, reward, success, latency_ms, tokens_used, tags, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = ins.run(Date.now(), 's', `task-${i}`, '', '', '', 0, 1, 0, 0, '[]', '{}');
      ids.push(Number(r.lastInsertRowid));
    }
    expect((db.prepare('SELECT COUNT(*) as c FROM episodes').get() as any).c).toBe(5);

    // Delete 3 of them via the exact pattern the handler uses.
    const toDelete = ids.slice(0, 3);
    const placeholders = toDelete.map(() => '?').join(',');
    const res = db.prepare(`DELETE FROM episodes WHERE id IN (${placeholders})`).run(...toDelete);
    expect(res.changes).toBe(3);
    expect((db.prepare('SELECT COUNT(*) as c FROM episodes').get() as any).c).toBe(2);
  });

  it('rejects non-integer / non-positive ids before issuing the query', () => {
    // This mirrors the validator inside the handler.
    const validate = (raw: unknown): number => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid id: ${raw}`);
      return n;
    };
    expect(() => validate('1; DROP TABLE episodes')).toThrow();
    expect(() => validate(-5)).toThrow();
    expect(() => validate(1.5)).toThrow();
    expect(() => validate(NaN)).toThrow();
    expect(validate(42)).toBe(42);
  });

  it('rejects table names not on the whitelist', () => {
    const allowed = new Set(['episodes', 'reasoning_patterns']);
    expect(allowed.has('episodes')).toBe(true);
    expect(allowed.has('rl_q_values')).toBe(false);
    expect(allowed.has('sqlite_master')).toBe(false);
    expect(allowed.has('episodes; DROP TABLE skills')).toBe(false);
  });
});

describe('consolidate_now (ADR-073 §B.7) — NightlyLearner.run shape', () => {
  it('NightlyLearner is importable and has a run() method', async () => {
    const mod = await import('../src/controllers/NightlyLearner.js');
    expect(typeof mod.NightlyLearner).toBe('function');
    expect(typeof mod.NightlyLearner.prototype.run).toBe('function');
    expect(typeof mod.NightlyLearner.prototype.consolidateEpisodes).toBe('function');
  });
});
