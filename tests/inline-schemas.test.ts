// Regression tests for ruvnet/agentdb#1 and #2 — schemas must load without
// touching `fs` / depending on `__dirname` resolution. The fix bundles them as
// string constants generated from src/schemas/*.sql at build time.

import { describe, it, expect } from 'vitest';
import { SCHEMA_SQL, FRONTIER_SCHEMA_SQL } from '../src/schemas/inline.js';

describe('inlined schemas (agentdb#1, #2)', () => {
  it('SCHEMA_SQL contains the core tables (episodes / episode_embeddings)', () => {
    expect(typeof SCHEMA_SQL).toBe('string');
    expect(SCHEMA_SQL.length).toBeGreaterThan(1000);
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS episodes\b/i);
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS episode_embeddings\b/i);
  });

  it('FRONTIER_SCHEMA_SQL contains the causal/frontier tables', () => {
    expect(typeof FRONTIER_SCHEMA_SQL).toBe('string');
    expect(FRONTIER_SCHEMA_SQL.length).toBeGreaterThan(1000);
    expect(FRONTIER_SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS causal_edges\b/i);
    expect(FRONTIER_SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS learning_experiences\b/i);
  });

  it("executing the inlined SQL against a fresh sql.js DB creates the schema tables", async () => {
    // Use the same backend resolver agentdb itself uses, so this test exercises
    // the real path. We force sql.js here to keep the test environment-independent
    // (better-sqlite3 may or may not be loadable on a given CI host).
    process.env.AGENTDB_FORCE_SQLJS = '1';
    const { createDatabase, _resetDatabaseImplementationForTests } = await import('../src/db-fallback.js');
    _resetDatabaseImplementationForTests();
    const db = await createDatabase(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec(FRONTIER_SCHEMA_SQL);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));

    expect(names.has('episodes')).toBe(true);            // #1: "no such table: episodes" must not happen
    expect(names.has('causal_edges')).toBe(true);
    expect(names.has('learning_experiences')).toBe(true);

    delete process.env.AGENTDB_FORCE_SQLJS;
    _resetDatabaseImplementationForTests();
  });
});
