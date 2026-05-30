// Regression tests for ADR-073 §C — security hardening round.
//
// Closes the three HIGH/MED findings from the deep review:
//   - parseJsonStrict() — no more unhandled SyntaxError from crafted CLI/MCP JSON
//   - validateSqlIdentifier() applied to migrate.ts table interpolation
//   - randomBytes() replaces Math.random() in ID generation (CWE-338)

import { describe, it, expect } from 'vitest';
import {
  parseJsonStrict,
  validateSqlIdentifier,
  ValidationError,
} from '../src/security/input-validation.js';

describe('parseJsonStrict (ADR-073 §C.1)', () => {
  it('parses valid JSON to the requested type', () => {
    expect(parseJsonStrict<{ a: number }>('{"a":1}', 'ctx')).toEqual({ a: 1 });
    expect(parseJsonStrict<number[]>('[1,2,3]', 'ctx')).toEqual([1, 2, 3]);
  });

  it('throws ValidationError (not SyntaxError) on malformed input', () => {
    expect(() => parseJsonStrict('not json at all', 'context')).toThrow(ValidationError);
    expect(() => parseJsonStrict('{"unclosed":', 'context')).toThrow(ValidationError);
    expect(() => parseJsonStrict('{a:1}', 'context')).toThrow(ValidationError);
  });

  it('rejects non-string inputs with a safe message', () => {
    expect(() => parseJsonStrict(123 as unknown as string, 'context')).toThrow(ValidationError);
    expect(() => parseJsonStrict(null as unknown as string, 'context')).toThrow(ValidationError);
  });

  it('never leaks the raw input or a stack trace in the error message', () => {
    const crafted = '{"oops":' + '"x"'.repeat(1000); // long unparseable
    try {
      parseJsonStrict(crafted, 'context');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const msg = (err as Error).message;
      // Safe message: mentions the field name, never the raw input.
      expect(msg).toContain('context');
      expect(msg).not.toContain('oops');
    }
  });
});

describe('validateSqlIdentifier (ADR-073 §C.2)', () => {
  it('accepts safe identifiers', () => {
    expect(validateSqlIdentifier('episodes')).toBe('episodes');
    expect(validateSqlIdentifier('rl_q_values')).toBe('rl_q_values');
    expect(validateSqlIdentifier('Skill_Embeddings_2')).toBe('Skill_Embeddings_2');
  });

  it('rejects classic SQL-injection identifier shapes', () => {
    for (const bad of [
      'episodes; DROP TABLE skills',
      "episodes' OR '1'='1",
      'episodes UNION SELECT * FROM rl_policies',
      'episodes--',
      '"escaped"',
      'spaces are bad',
      '',
    ]) {
      expect(() => validateSqlIdentifier(bad)).toThrow();
    }
  });
});

describe('CSPRNG-backed ID generation (ADR-073 §C.3)', () => {
  it('agentdb-fast.ts generateId() output is no longer dependent on Math.random', async () => {
    // The wrapper module imports node:crypto.randomBytes (statically).
    // Reading the source is the gate that prevents regression — Math.random()
    // appearing here again means someone undid the fix.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'src', 'wrappers', 'agentdb-fast.ts'),
      'utf-8',
    );
    // No Math.random anywhere in the file (was in generateId).
    expect(src).not.toMatch(/Math\.random/);
    // Uses node:crypto for CSPRNG.
    expect(src).toMatch(/from ['"]node:crypto['"]/);
    expect(src).toMatch(/randomBytes/);
  });

  it('GraphDatabaseAdapter episode/skill IDs use randomBytes, not Math.random', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'src', 'backends', 'graph', 'GraphDatabaseAdapter.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/Math\.random/);
    expect(src).toMatch(/randomBytes/);
  });
});
