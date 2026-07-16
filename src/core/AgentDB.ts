/**
 * AgentDB - Main database wrapper class
 *
 * Provides a unified interface to all AgentDB controllers with:
 * - sql.js WASM for relational storage (with better-sqlite3 fallback)
 * - RuVector for optimized vector search (150x faster than SQLite)
 * - Unified integration passing vector backend to all controllers
 */
import { ReflexionMemory } from '../controllers/ReflexionMemory.js';
import { SkillLibrary } from '../controllers/SkillLibrary.js';
import { CausalMemoryGraph } from '../controllers/CausalMemoryGraph.js';
import { EmbeddingService } from '../controllers/EmbeddingService.js';
import { MemoryController } from '../controllers/MemoryController.js';
import { createBackend } from '../backends/factory.js';
import type { VectorBackend } from '../backends/VectorBackend.js';
import type { IDatabaseConnection } from '../types/database.types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AgentDBConfig {
  dbPath?: string;
  namespace?: string;
  enableAttention?: boolean;
  attentionConfig?: Record<string, any>;
  /** Force use of sql.js WASM even if better-sqlite3 is available */
  forceWasm?: boolean;
  /** Vector backend type: 'auto' | 'ruvector' | 'hnswlib' */
  vectorBackend?: 'auto' | 'ruvector' | 'hnswlib';
  /** Vector dimension (default: 384 for MiniLM) */
  vectorDimension?: number;

  /**
   * How embeddings are generated. Previously hardcoded to a local MiniLM, so
   * the 'openai' provider EmbeddingService implements was unreachable from
   * here.
   *
   * Note `vectorDimension` must match the model: MiniLM is 384,
   * text-embedding-3-small is 1536.
   */
  embedding?: {
    /**
     * 'transformers' — real local model (default).
     * 'openai'       — remote; needs apiKey (or OPENAI_API_KEY).
     * 'local'        — hash stub for tests, NOT a local model.
     */
    provider?: 'transformers' | 'openai' | 'local';
    /** Model id. Defaults to Xenova/all-MiniLM-L6-v2 for transformers. */
    model?: string;
    /** Remote provider key. Falls back to OPENAI_API_KEY. */
    apiKey?: string;
    /**
     * Permit silent degradation to hash stubs when the real model can't load.
     * Off by default — see EmbeddingService.
     */
    allowMockFallback?: boolean;
  };
}

/** Sensible model per provider when the caller doesn't name one. */
function defaultModelFor(provider: 'transformers' | 'openai' | 'local'): string {
  switch (provider) {
    case 'openai':
      return 'text-embedding-3-small';
    case 'local':
      return 'mock-model';
    default:
      return 'Xenova/all-MiniLM-L6-v2';
  }
}

export class AgentDB {
  private db!: IDatabaseConnection;
  private reflexion!: ReflexionMemory;
  private memoryController!: MemoryController;
  private skills!: SkillLibrary;
  private causalGraph!: CausalMemoryGraph;
  private embedder!: EmbeddingService;
  public vectorBackend!: VectorBackend;
  private initialized = false;
  private config: AgentDBConfig;
  private usingWasm = false;

  constructor(config: AgentDBConfig = {}) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const dbPath = this.config.dbPath || ':memory:';
    const vectorDimension = this.config.vectorDimension || 384;

    // Initialize database with unified fallback system
    this.db = await this.initializeDatabase(dbPath);

    // Load schemas
    await this.loadSchemas();

    // Initialize embedder. Defaults to the local Xenova model, but the
    // provider/model/key are now caller-configurable instead of hardcoded.
    const embeddingConfig = this.config.embedding ?? {};
    const provider = embeddingConfig.provider ?? 'transformers';
    this.embedder = new EmbeddingService({
      model: embeddingConfig.model ?? defaultModelFor(provider),
      dimension: vectorDimension,
      provider,
      apiKey: embeddingConfig.apiKey ?? process.env.OPENAI_API_KEY,
      allowMockFallback: embeddingConfig.allowMockFallback
    });
    await this.embedder.initialize();

    // Initialize vector backend (RuVector preferred, HNSWLib fallback).
    // Give the index a path derived from this database's own path. Without
    // one, a persistent backend falls back to a single engine-default file in
    // the CWD that every database shares — so another database's vectors come
    // back in this one's search results. An in-memory database has nowhere to
    // anchor an index, so it gets an isolated ephemeral one.
    this.vectorBackend = await createBackend(this.config.vectorBackend || 'auto', {
      dimensions: vectorDimension,
      metric: 'cosine',
      storagePath: dbPath === ':memory:' ? undefined : `${dbPath}.vectors`
    });

    // Attention-enhanced memory. AgentDBConfig has advertised enableAttention
    // and attentionConfig since v2 and nothing ever read them, so the whole
    // attention subsystem — MemoryController, self/cross/multi-head — shipped
    // built but unreachable: getController('self-attention') threw "Unknown
    // controller".
    this.memoryController = new MemoryController(this.vectorBackend, {
      namespace: this.config.namespace,
      enableAttention: this.config.enableAttention !== false,
      ...(this.config.attentionConfig ?? {}),
      numHeads: this.config.attentionConfig?.multiHeadAttention?.numHeads ?? 8,
    });

    // Initialize controllers WITH vector backend for optimized search
    // This enables 150x faster vector search via RuVector instead of SQLite brute-force
    this.reflexion = new ReflexionMemory(this.db, this.embedder, this.vectorBackend);
    this.skills = new SkillLibrary(this.db, this.embedder, this.vectorBackend);
    this.causalGraph = new CausalMemoryGraph(
      this.db,
      undefined, // graphBackend - not used in default initialization
      this.embedder,
      undefined, // config - use defaults
      this.vectorBackend
    );

    this.initialized = true;

    console.log(`[AgentDB] Initialized with ${this.usingWasm ? 'sql.js WASM' : 'better-sqlite3'} + ${this.vectorBackend.name} vector backend`);
  }

  /**
   * Initialize database with automatic fallback:
   * 1. Try better-sqlite3 (native, fastest)
   * 2. Fallback to sql.js WASM (no build tools required)
   */
  private async initializeDatabase(dbPath: string): Promise<IDatabaseConnection> {
    // Force WASM if requested
    if (this.config.forceWasm) {
      return this.initializeSqlJsWasm(dbPath);
    }

    // Try better-sqlite3 first (native performance)
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      this.usingWasm = false;
      return db as unknown as IDatabaseConnection;
    } catch (error) {
      // better-sqlite3 not available or failed, try sql.js WASM
      console.log('[AgentDB] better-sqlite3 not available, using sql.js WASM');
      return this.initializeSqlJsWasm(dbPath);
    }
  }

  /**
   * Initialize sql.js WASM database
   */
  private async initializeSqlJsWasm(dbPath: string): Promise<IDatabaseConnection> {
    const { createDatabase } = await import('../db-fallback.js');
    const db = await createDatabase(dbPath);
    this.usingWasm = true;
    return db as IDatabaseConnection;
  }

  /**
   * Load database schemas.
   *
   * Uses inlined SQL constants (src/schemas/inline.ts, generated from the .sql
   * files at build time) so this works in:
   *   - the browser (no `fs` available) — fixes #2
   *   - globally-installed CLIs where __dirname resolution misses dist/schemas
   *     (the "Schema file not found" warning at install time) — fixes #1
   */
  private async loadSchemas(): Promise<void> {
    const { SCHEMA_SQL, FRONTIER_SCHEMA_SQL } = await import('../schemas/inline.js');
    if (SCHEMA_SQL) this.db.exec(SCHEMA_SQL);
    if (FRONTIER_SCHEMA_SQL) this.db.exec(FRONTIER_SCHEMA_SQL);
  }

  /** Whether attention controllers were enabled for this instance. */
  private get attentionEnabled(): boolean {
    return this.config.enableAttention !== false;
  }

  /**
   * Names accepted by getController(), for discovery.
   *
   * Attention controllers only appear when enableAttention is on, so the list
   * reflects what is actually reachable rather than what exists in the build.
   */
  listControllers(): string[] {
    const names = ['memory', 'reflexion', 'skills', 'causal', 'causalGraph'];
    if (this.attentionEnabled) {
      names.push('self-attention', 'cross-attention', 'multi-head-attention');
    }
    return names;
  }

  getController(name: string): any {
    if (!this.initialized) {
      throw new Error('AgentDB not initialized. Call initialize() first.');
    }

    switch (name) {
      // 'memory' is the attention-capable MemoryController (store/retrieve/
      // search/retrieveWithAttention). 'reflexion' remains the episodic store.
      case 'memory':
        return this.memoryController;
      case 'reflexion':
        return this.reflexion;
      case 'self-attention':
      case 'cross-attention':
      case 'multi-head-attention':
        // Honour enableAttention: with it off these are not offered at all,
        // rather than handed out as controllers that quietly do nothing.
        if (!this.attentionEnabled) {
          throw new Error(
            `Unknown controller: ${name} (attention is disabled — construct AgentDB with enableAttention: true)`
          );
        }
        if (name === 'self-attention') return this.memoryController.selfAttentionController;
        if (name === 'cross-attention') return this.memoryController.crossAttentionController;
        return this.memoryController.multiHeadAttentionController;
      case 'skills':
        return this.skills;
      case 'causal':
      case 'causalGraph':
        return this.causalGraph;
      default:
        throw new Error(`Unknown controller: ${name}`);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
    }
  }

  // Expose database for advanced usage
  get database(): IDatabaseConnection {
    return this.db;
  }

  // Check if using WASM backend
  get isWasm(): boolean {
    return this.usingWasm;
  }

  // Get vector backend info
  get vectorBackendName(): string {
    return this.vectorBackend?.name || 'none';
  }

  /**
   * What is actually generating embeddings — 'transformers', 'openai', or
   * 'mock'. Worth checking at startup: 'mock' means hash stubs with no
   * semantic meaning, so every recall is noise. There was previously no way
   * to ask this from outside.
   */
  get embeddingProvider(): 'transformers' | 'openai' | 'mock' | 'none' {
    return this.embedder?.getActiveProvider() ?? 'none';
  }

  /** True when embeddings are hash stubs rather than a real model. */
  get usingMockEmbeddings(): boolean {
    return this.embedder?.isUsingMockEmbeddings() ?? false;
  }
}
