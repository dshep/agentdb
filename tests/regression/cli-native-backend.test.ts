/**
 * Regression tests for the two defects that shipped in v3.0.0-alpha.17.
 *
 * Both were CLI-level failures against the *native* better-sqlite3 backend.
 * The existing suite drove the controllers directly and never exercised the
 * CLI over the native driver, so neither was caught:
 *
 *   1. `this.db.save is not a function` — `save()` only exists on the sql.js
 *      (WASM) wrapper, which buffers the DB in memory until exported. Native
 *      better-sqlite3 commits on write and has no such method. Once native
 *      became the preferred backend, every unguarded `this.db.save()` threw,
 *      breaking store-pattern / skill create / causal experiment / consolidate.
 *
 *   2. `agentdb init` read schemas from `dist/schemas/*.sql`, which aren't in
 *      the published package. It warned, created only `agentdb_config`, and
 *      still reported "initialized successfully" — leaving a table-less DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDatabase } from '../../src/db-fallback.js';
import { initCommand } from '../../src/cli/commands/init.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-cli-regression-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('init command creates the real schema (agentdb#1)', () => {
  it('creates the core tables, not just agentdb_config', async () => {
    const dbPath = path.join(tmpDir, 'init.db');
    await initCommand({ dbPath });

    const db = await createDatabase(dbPath);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    // The bug: only agentdb_config survived, so a subsequent store-pattern
    // was writing into a database with no episodes table.
    expect(tables).toContain('episodes');
    expect(tables).toContain('episode_embeddings');
    expect(tables).toContain('skills');
    expect(tables).toContain('agentdb_config');
  });

  it('produces a database that accepts an episode insert', async () => {
    const dbPath = path.join(tmpDir, 'insert.db');
    await initCommand({ dbPath });

    const db = await createDatabase(dbPath);
    db.prepare(
      'INSERT INTO episodes (session_id, task, reward, success) VALUES (?, ?, ?, ?)'
    ).run('s1', 'experience:code-edits', 0.9, 1);

    const rows = db.prepare('SELECT task, reward FROM episodes').all() as Array<{
      task: string;
      reward: number;
    }>;
    expect(rows).toEqual([{ task: 'experience:code-edits', reward: 0.9 }]);
  });
});

describe('save() is not part of the cross-backend contract (ruflo#2235 A)', () => {
  it('native better-sqlite3 commits without save(), so callers must guard', async () => {
    const dbPath = path.join(tmpDir, 'durable.db');
    const db = await createDatabase(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('alpha');

    // This is the exact divergence that broke the CLI: the parity test in
    // db-fallback-native.test.ts covered prepare/run/all but not save(), so
    // nothing flagged that unguarded `db.save()` is backend-specific.
    if (typeof db.save !== 'function') {
      // Native path — the write must already be durable on disk without save().
      const reopened = await createDatabase(dbPath);
      const rows = reopened.prepare('SELECT name FROM t').all() as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(['alpha']);
    } else {
      // sql.js path — save() must exist and be callable.
      expect(() => db.save()).not.toThrow();
    }
  });

  it('the guarded-persist idiom is safe on whichever backend resolves', async () => {
    const db = await createDatabase(path.join(tmpDir, 'guard.db'));

    // Mirrors AgentDBCLI.persist(). Unguarded, this threw
    // "this.db.save is not a function" on native.
    const persist = () => {
      if (db && typeof db.save === 'function') db.save();
    };

    expect(() => persist()).not.toThrow();
  });

  it('no CLI call site invokes db.save() unguarded', () => {
    // The contract tests above pass even against the broken code, because the
    // defect was never in db-fallback — it was five unguarded call sites in
    // the CLI. Driving those for real needs the transformers embedder (slow,
    // needs the model cached), so assert the invariant at the source instead:
    // every save() must go through the typeof guard in persist().
    const cliSource = fs.readFileSync(
      path.join(__dirname, '../../src/cli/agentdb-cli.ts'),
      'utf-8'
    );

    const unguarded = cliSource
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /\bthis\.db\.save\s*\(/.test(line))
      // The lone legitimate call lives inside persist(), behind the guard.
      .filter(({ no }) => {
        const guardWindow = cliSource.split('\n').slice(Math.max(0, no - 3), no).join('\n');
        return !/typeof this\.db\.save === 'function'/.test(guardWindow);
      });

    expect(
      unguarded.map((u) => `line ${u.no}: ${u.line}`),
      'unguarded this.db.save() crashes on native better-sqlite3 — route it through this.persist()'
    ).toEqual([]);
  });
});
