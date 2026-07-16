/**
 * EmbeddingService - Text Embedding Generation
 *
 * Handles text-to-vector embedding generation using various models.
 * Supports both local (transformers.js) and remote (OpenAI, etc.) embeddings.
 */

export interface EmbeddingConfig {
  model: string;
  dimension: number;
  /**
   * 'transformers' — real local model (transformers.js).
   * 'openai'       — real remote model; requires apiKey.
   * 'local'        — NOT a local model: deterministic hash stub for tests.
   *                  It carries no semantic signal whatsoever.
   */
  provider: 'transformers' | 'openai' | 'local';
  apiKey?: string;
  /**
   * Permit silently degrading to the hash stub when a real provider can't be
   * reached. Off by default: a stub embedding is not a slower embedding, it is
   * a wrong one, and every downstream similarity becomes noise. Opt in only
   * for tests/offline work, or set AGENTDB_ALLOW_MOCK_EMBEDDINGS=1.
   */
  allowMockFallback?: boolean;
}

export class EmbeddingService {
  private config: EmbeddingConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transformers.js pipeline has no exported type
  private pipeline: any;
  private cache: Map<string, Float32Array>;
  /** True once we have actually fallen back to hash stubs. */
  private usingMock: boolean;

  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.cache = new Map();
    // 'local' asks for the stub outright; the others only reach it by failing.
    this.usingMock = config.provider === 'local';
  }

  /** Whether embeddings are hash stubs rather than a real model. */
  isUsingMockEmbeddings(): boolean {
    return this.usingMock;
  }

  /** What is actually generating vectors right now, whatever was requested. */
  getActiveProvider(): 'transformers' | 'openai' | 'mock' {
    if (this.usingMock) return 'mock';
    return this.config.provider === 'openai' ? 'openai' : 'transformers';
  }

  /** Mock stubs allowed either by config or by env (for CI/offline). */
  private mockFallbackAllowed(): boolean {
    return (
      this.config.allowMockFallback === true ||
      process.env.AGENTDB_ALLOW_MOCK_EMBEDDINGS === '1'
    );
  }

  /**
   * Initialize the embedding service
   */
  async initialize(): Promise<void> {
    if (this.config.provider === 'transformers') {
      // Use transformers.js for local embeddings
      try {
        const transformers = await import('@xenova/transformers');

        const env = transformers.env as Record<string, unknown>;

        // transformers.env is a process-wide singleton, so pinning it to one
        // model's local copy leaks to every EmbeddingService created later:
        // the next one, for a different model, would find remote downloads
        // disabled and a localModelPath pointing at the wrong tree. Snapshot
        // the keys we touch and restore them once the pipeline is built.
        const envSnapshot: Record<string, unknown> = {
          localModelPath: env.localModelPath,
          allowRemoteModels: env.allowRemoteModels,
          cacheDir: env.cacheDir,
        };

        try {
          // Try to load model from bundled .rvf or local cache first
          try {
            const { ModelCacheLoader } = await import('../model/ModelCacheLoader.js');
            const cached = await ModelCacheLoader.resolve(this.config.model);

            if (cached) {
              // A local copy exists — use it and don't touch the network.
              env.localModelPath = cached.localPath;
              env.allowRemoteModels = false;
              env.cacheDir = cached.localPath;
            }
          } catch {
            // ModelCacheLoader not available — fall through to network download
          }

          // Set Hugging Face token if available from environment
          const hfToken = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
          if (hfToken && typeof env === 'object') {
            env.HF_TOKEN = hfToken;
          }

          this.pipeline = await transformers.pipeline('feature-extraction', this.config.model);
        } finally {
          // pipeline() has read what it needs; hand the global env back as we
          // found it, whether we succeeded or threw.
          for (const [key, value] of Object.entries(envSnapshot)) {
            if (value === undefined) {
              delete env[key];
            } else {
              env[key] = value;
            }
          }
        }
        console.log(`Transformers.js loaded: ${this.config.model}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.pipeline = null;

        // Previously this warned once and then quietly emitted hash stubs for
        // the rest of the process. Callers had no way to tell, so a database
        // could fill with meaningless vectors and every recall silently return
        // noise. Fail unless the caller has explicitly accepted stubs.
        if (!this.mockFallbackAllowed()) {
          throw new Error(
            `Failed to load embedding model '${this.config.model}': ${errorMessage}\n` +
            `\n` +
            `Refusing to fall back to mock embeddings — they are deterministic\n` +
            `hashes with no semantic meaning, so stored vectors and every search\n` +
            `over them would be silently wrong.\n` +
            `\n` +
            `Fix one of:\n` +
            `  - Pre-download the model:  npx agentdb install-embeddings\n` +
            `  - Restore network access (first run fetches ~90MB)\n` +
            `  - Use a remote provider:   provider: 'openai' with an apiKey\n` +
            `\n` +
            `If mock embeddings are genuinely what you want (tests/offline), opt in\n` +
            `explicitly with allowMockFallback: true or AGENTDB_ALLOW_MOCK_EMBEDDINGS=1.`
          );
        }

        this.usingMock = true;
        console.warn(
          `⚠️  [EmbeddingService] Using MOCK embeddings — '${this.config.model}' failed to load: ${errorMessage}`
        );
        console.warn(
          `⚠️  Vectors are hash stubs with no semantic meaning. Search results will be noise.`
        );
        console.warn(
          `⚠️  Allowed because ${this.config.allowMockFallback === true ? 'allowMockFallback: true' : 'AGENTDB_ALLOW_MOCK_EMBEDDINGS=1'} was set.`
        );
      }
    } else if (this.config.provider === 'openai') {
      // Catch a missing key at startup rather than letting embed() silently
      // route every call to the hash stub.
      if (!this.config.apiKey) {
        if (!this.mockFallbackAllowed()) {
          throw new Error(
            `Embedding provider 'openai' requires an apiKey.\n` +
            `Pass config.apiKey or set OPENAI_API_KEY.\n` +
            `\n` +
            `Without it every embedding would silently be a meaningless hash stub.\n` +
            `To accept that explicitly, set allowMockFallback: true or ` +
            `AGENTDB_ALLOW_MOCK_EMBEDDINGS=1.`
          );
        }
        this.usingMock = true;
        console.warn(
          `⚠️  [EmbeddingService] provider 'openai' has no apiKey — using MOCK embeddings (hash stubs, no semantic meaning).`
        );
      }
    } else if (this.config.provider === 'local') {
      // 'local' is the stub. Say so plainly — the name reads like "a local
      // model", which is exactly backwards.
      console.warn(
        `⚠️  [EmbeddingService] provider 'local' generates MOCK hash embeddings with no semantic meaning. ` +
        `Use provider: 'transformers' for a real local model.`
      );
    }
  }

  /**
   * Generate embedding for text
   */
  async embed(text: string): Promise<Float32Array> {
    // Check cache
    const cacheKey = `${this.config.model}:${text}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let embedding: Float32Array;

    if (this.config.provider === 'transformers' && this.pipeline) {
      // Use transformers.js
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
      embedding = new Float32Array(output.data);
    } else if (this.config.provider === 'openai' && this.config.apiKey) {
      // Use OpenAI API
      embedding = await this.embedOpenAI(text);
    } else if (this.usingMock) {
      // Stub embeddings, but only where initialize() established that the
      // caller asked for or accepted them.
      embedding = this.mockEmbedding(text);
    } else {
      // A real provider was configured and never initialised into a usable
      // state. Falling through to the stub here is what made bad vectors
      // indistinguishable from good ones.
      throw new Error(
        `Embedding provider '${this.config.provider}' is not ready — call initialize() first.\n` +
        `Refusing to substitute mock embeddings silently. See allowMockFallback.`
      );
    }

    // Cache result
    if (this.cache.size > 10000) {
      // Simple LRU: clear half the cache
      const keysToDelete = Array.from(this.cache.keys()).slice(0, 5000);
      keysToDelete.forEach(k => this.cache.delete(k));
    }
    this.cache.set(cacheKey, embedding);

    return embedding;
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  /**
   * Clear embedding cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  private async embedOpenAI(text: string): Promise<Float32Array> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text
      })
    });

    // The response was previously parsed without checking status, so an auth
    // failure or rate limit surfaced as "Cannot read properties of undefined
    // (reading '0')" — a TypeError that says nothing about the real problem.
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        detail = body?.error?.message ? `: ${body.error.message}` : '';
      } catch {
        detail = '';
      }
      throw new Error(
        `OpenAI embeddings request failed (HTTP ${response.status} ${response.statusText})${detail}\n` +
        `Model: ${this.config.model}`
      );
    }

    const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    const embedding = data?.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error(
        `OpenAI embeddings response contained no embedding for model '${this.config.model}'.`
      );
    }

    const vector = new Float32Array(embedding);
    // A model/dimension mismatch otherwise fails later, inside the vector
    // index, as an opaque error far from its cause.
    if (vector.length !== this.config.dimension) {
      throw new Error(
        `Embedding dimension mismatch: model '${this.config.model}' returned ${vector.length} ` +
        `dimensions but this database is configured for ${this.config.dimension}.\n` +
        `Re-initialise with --dimension ${vector.length}, or choose a model that matches.`
      );
    }
    return vector;
  }

  private mockEmbedding(text: string): Float32Array {
    // Simple deterministic mock embedding for testing
    const embedding = new Float32Array(this.config.dimension);

    // Handle null/undefined/empty text
    if (!text || text.length === 0) {
      return new Float32Array(this.config.dimension);
    }

    // Use simple hash-based generation
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }

    // Fill embedding with pseudo-random values based on hash
    for (let i = 0; i < this.config.dimension; i++) {
      const seed = hash + i * 31;
      embedding[i] = Math.sin(seed) * Math.cos(seed * 0.5);
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);

    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }

    return embedding;
  }
}
