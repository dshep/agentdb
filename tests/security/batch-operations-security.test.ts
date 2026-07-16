/**
 * Batch Operations Security Tests
 *
 * Comprehensive security testing for BatchOperations to prevent:
 * - SQL injection via table names
 * - SQL injection via column names
 * - SQL injection via condition values
 * - Malicious input in bulk operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchOperations } from '../../src/optimizations/BatchOperations.js';
import { EmbeddingService } from '../../src/controllers/EmbeddingService.js';
import { ValidationError } from '../../src/security/input-validation.js';

describe('BatchOperations Security Tests', () => {
  let db: Database.Database;
  let embedder: EmbeddingService;
  let batchOps: BatchOperations;

  beforeEach(async () => {
    // Create in-memory database
    db = new Database(':memory:');

    // Create test schema
    db.exec(`
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER DEFAULT (strftime('%s', 'now')),
        session_id TEXT NOT NULL,
        task TEXT NOT NULL,
        input TEXT,
        output TEXT,
        critique TEXT,
        reward REAL NOT NULL,
        success INTEGER NOT NULL,
        latency_ms INTEGER,
        tokens_used INTEGER,
        tags TEXT,
        metadata TEXT
      );

      CREATE TABLE episode_embeddings (
        episode_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER DEFAULT (strftime('%s', 'now')),
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        signature TEXT,
        code TEXT,
        success_rate REAL DEFAULT 0.0,
        uses INTEGER DEFAULT 0,
        avg_reward REAL DEFAULT 0.0,
        avg_latency_ms REAL DEFAULT 0.0,
        tags TEXT,
        metadata TEXT
      );

      CREATE TABLE skill_embeddings (
        skill_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
      );
    `);

    // Initialize embedder (mock mode)
    // 'local' is the deterministic stub. This asked for provider
    // 'transformers' with a model literally named 'mock', so it tried to fetch
    // "mock" from HuggingFace, failed, and silently fell back to stubs anyway.
    // These are input-validation tests — they don't need real embeddings, they
    // need fast deterministic ones, so ask for that directly.
    embedder = new EmbeddingService({
      model: 'mock-model',
      dimension: 384,
      provider: 'local'
    });
    await embedder.initialize();

    // Initialize batch operations
    batchOps = new BatchOperations(db, embedder);
  });

  afterEach(() => {
    db.close();
  });

  describe('SQL Injection Prevention - Table Names', () => {
    it('should reject malicious table names with SQL injection attempts', () => {
      const maliciousTableNames = [
        'episodes; DROP TABLE episodes--',
        'episodes\'; DROP TABLE episodes--',
        'episodes" OR "1"="1',
        'episodes UNION SELECT * FROM sqlite_master--',
        '../../../etc/passwd',
        'episodes\x00malicious',
        'episodes\nDROP TABLE',
      ];

      for (const tableName of maliciousTableNames) {
        expect(() => {
          batchOps.bulkDelete(tableName, { id: 1 });
        }).toThrow(ValidationError);
      }
    });

    it('should only accept whitelisted table names', () => {
      // Valid tables should work
      const validTables = ['episodes', 'skills', 'episode_embeddings', 'skill_embeddings'];

      for (const table of validTables) {
        // Should not throw
        expect(() => {
          try {
            batchOps.bulkDelete(table, { id: 999999 });
          } catch (e) {
            // Might throw if table doesn't exist, but shouldn't be ValidationError
            if (e instanceof ValidationError) {
              throw e;
            }
          }
        }).not.toThrow(ValidationError);
      }

      // Invalid tables should be rejected
      const invalidTables = [
        'users',
        'admin',
        'sqlite_master',
        'information_schema',
        'pg_catalog'
      ];

      for (const table of invalidTables) {
        expect(() => {
          batchOps.bulkDelete(table, { id: 1 });
        }).toThrow(ValidationError);
      }
    });

    it('should reject case variations of invalid tables', () => {
      const invalidCases = [
        'EPISODES; DROP--',
        'Episodes; DROP--',
        'ePiSoDes; DROP--'
      ];

      for (const tableName of invalidCases) {
        expect(() => {
          batchOps.bulkDelete(tableName, { id: 1 });
        }).toThrow(ValidationError);
      }
    });
  });

  describe('SQL Injection Prevention - Column Names', () => {
    it('should reject malicious column names in conditions', () => {
      const maliciousColumns = {
        'id; DROP TABLE episodes--': 1,
        'id\' OR \'1\'=\'1': 1,
        'id" OR "1"="1': 1,
        'id UNION SELECT password FROM users--': 1,
      };

      expect(() => {
        batchOps.bulkDelete('episodes', maliciousColumns);
      }).toThrow(ValidationError);
    });

    it('should reject malicious column names in updates', () => {
      const maliciousUpdates = {
        'reward; DROP TABLE--': 0.5,
      };

      expect(() => {
        batchOps.bulkUpdate('episodes', maliciousUpdates, { id: 1 });
      }).toThrow(ValidationError);
    });

    it('should only accept whitelisted column names', () => {
      // Valid columns for episodes table
      const validColumns = ['id', 'session_id', 'task', 'reward', 'success'];

      for (const column of validColumns) {
        // Should not throw ValidationError
        expect(() => {
          try {
            batchOps.bulkDelete('episodes', { [column]: 'test' });
          } catch (e) {
            if (e instanceof ValidationError) {
              throw e;
            }
          }
        }).not.toThrow(ValidationError);
      }

      // Invalid columns should be rejected
      const invalidColumns = ['password', 'admin', 'role', 'permissions'];

      for (const column of invalidColumns) {
        expect(() => {
          batchOps.bulkDelete('episodes', { [column]: 'test' });
        }).toThrow(ValidationError);
      }
    });
  });

  describe('SQL Injection Prevention - Condition Values', () => {
    it('should safely handle special characters in values', () => {
      // Insert test data
      const stmt = db.prepare(`
        INSERT INTO episodes (session_id, task, reward, success)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run('test-session', 'test-task', 0.5, 1);

      // These values should be safely parameterized
      const specialValues = {
        session_id: "'; DROP TABLE episodes--",
      };

      // Should execute safely (no SQL injection)
      const deleted = batchOps.bulkDelete('episodes', specialValues);
      expect(deleted).toBe(0); // No match, so no deletions

      // Verify table still exists
      const count = db.prepare('SELECT COUNT(*) as count FROM episodes').get() as any;
      expect(count.count).toBe(1);
    });

    it('should safely handle null bytes in values', () => {
      const maliciousValues = {
        session_id: "test\x00malicious",
      };

      // Should execute safely
      const deleted = batchOps.bulkDelete('episodes', maliciousValues);
      expect(deleted).toBe(0);
    });

    it('should safely handle unicode and special SQL characters', () => {
      const specialCharValues = {
        session_id: "test'; SELECT * FROM sqlite_master WHERE '1'='1",
      };

      // Should execute safely with parameterized query
      const deleted = batchOps.bulkDelete('episodes', specialCharValues);
      expect(deleted).toBe(0);
    });
  });

  describe('Bulk Update Security', () => {
    beforeEach(() => {
      // Insert test data
      const stmt = db.prepare(`
        INSERT INTO episodes (session_id, task, reward, success)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run('session-1', 'task-1', 0.5, 1);
    });

    it('should prevent SQL injection in SET clause', () => {
      const maliciousUpdate = {
        'reward; DROP TABLE episodes--': 0.9,
      };

      expect(() => {
        batchOps.bulkUpdate('episodes', maliciousUpdate, { id: 1 });
      }).toThrow(ValidationError);
    });

    it('should prevent SQL injection in WHERE clause', () => {
      const maliciousCondition = {
        'id; DROP TABLE episodes--': 1,
      };

      expect(() => {
        batchOps.bulkUpdate('episodes', { reward: 0.9 }, maliciousCondition);
      }).toThrow(ValidationError);
    });

    it('should safely update with special characters in values', () => {
      const updates = {
        task: "'; DROP TABLE episodes--",
      };

      const conditions = {
        id: 1,
      };

      // Should execute safely
      const updated = batchOps.bulkUpdate('episodes', updates, conditions);
      expect(updated).toBe(1);

      // Verify the value was stored correctly (not executed)
      const row = db.prepare('SELECT task FROM episodes WHERE id = 1').get() as any;
      expect(row.task).toBe("'; DROP TABLE episodes--");

      // Verify table still exists
      const count = db.prepare('SELECT COUNT(*) as count FROM episodes').get() as any;
      expect(count.count).toBe(1);
    });
  });

  describe('Empty and Invalid Inputs', () => {
    it('should reject empty conditions object', () => {
      expect(() => {
        batchOps.bulkDelete('episodes', {});
      }).toThrow(ValidationError);
    });

    it('should reject empty updates object', () => {
      expect(() => {
        batchOps.bulkUpdate('episodes', {}, { id: 1 });
      }).toThrow(ValidationError);
    });

    it('should reject null or undefined inputs', () => {
      expect(() => {
        batchOps.bulkDelete('episodes', null as any);
      }).toThrow(ValidationError);

      expect(() => {
        batchOps.bulkUpdate('episodes', undefined as any, { id: 1 });
      }).toThrow(ValidationError);
    });
  });

  describe('Integration Tests - Full Attack Scenarios', () => {
    it('should resist combined SQL injection attack', () => {
      // Attacker tries to inject SQL at multiple points
      const attackVector = {
        table: 'episodes; DROP TABLE skills--',
        column: 'id\' OR \'1\'=\'1--',
        value: "'; DELETE FROM episodes WHERE '1'='1--",
      };

      expect(() => {
        batchOps.bulkDelete(attackVector.table, {
          [attackVector.column]: attackVector.value
        });
      }).toThrow(ValidationError);

      // Verify all tables still exist
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all() as any[];

      expect(tables.length).toBeGreaterThan(0);
      expect(tables.some(t => t.name === 'episodes')).toBe(true);
      expect(tables.some(t => t.name === 'skills')).toBe(true);
    });

    it('should resist timing-based SQL injection', () => {
      const maliciousConditions = {
        // Attempt to use SLEEP or timing functions
        session_id: "test' AND SLEEP(5)--",
      };

      const startTime = Date.now();
      const deleted = batchOps.bulkDelete('episodes', maliciousConditions);
      const endTime = Date.now();

      // Should complete quickly (no sleep executed)
      expect(endTime - startTime).toBeLessThan(1000);
      expect(deleted).toBe(0);
    });

    it('should resist boolean-based blind SQL injection', () => {
      const blindInjectionAttempts = [
        { session_id: "test' AND 1=1--" },
        { session_id: "test' AND 1=2--" },
        { session_id: "test' OR 'x'='x--" },
      ];

      for (const attempt of blindInjectionAttempts) {
        // All should be treated as literal strings (no injection)
        const deleted = batchOps.bulkDelete('episodes', attempt);
        expect(deleted).toBe(0);
      }
    });
  });

  describe('Error Message Security', () => {
    it('should not leak sensitive information in error messages', () => {
      try {
        batchOps.bulkDelete('invalid_table', { id: 1 });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        const err = error as ValidationError;
        // Error should not expose internal paths or database structure
        expect(err.message).not.toContain('sqlite');
        expect(err.message).not.toContain('/var/');
        expect(err.message).not.toContain('C:\\');
      }
    });

    it('should provide safe error codes', () => {
      try {
        batchOps.bulkDelete('episodes', {});
      } catch (error) {
        const err = error as ValidationError;
        expect(err.code).toBeTruthy();
        expect(typeof err.code).toBe('string');
      }
    });
  });

  describe('Transaction Safety', () => {
    it('should rollback on validation errors', () => {
      // Insert test data
      db.prepare(`
        INSERT INTO episodes (session_id, task, reward, success)
        VALUES (?, ?, ?, ?)
      `).run('session-1', 'task-1', 0.5, 1);

      const countBefore = db.prepare('SELECT COUNT(*) as count FROM episodes').get() as any;

      try {
        // This should fail validation
        batchOps.bulkUpdate(
          'episodes',
          { 'malicious; DROP--': 'value' },
          { id: 1 }
        );
      } catch (error) {
        // Expected to throw
      }

      // Count should remain the same (no partial updates)
      const countAfter = db.prepare('SELECT COUNT(*) as count FROM episodes').get() as any;
      expect(countAfter.count).toBe(countBefore.count);
    });
  });

  describe('Performance - No DoS via Complex Queries', () => {
    it('should handle large condition sets efficiently', () => {
      const largeConditions: Record<string, any> = {};

      // Try to create extremely complex WHERE clause
      for (let i = 0; i < 100; i++) {
        largeConditions[`session_id_${i}`] = `value_${i}`;
      }

      // Should either execute quickly or reject before constructing query
      const startTime = Date.now();
      try {
        batchOps.bulkDelete('episodes', largeConditions);
      } catch (error) {
        // May throw due to invalid column names
      }
      const endTime = Date.now();

      // Should not take more than 1 second
      expect(endTime - startTime).toBeLessThan(1000);
    });
  });
});
