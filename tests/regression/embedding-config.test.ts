/**
 * Regression tests for embedding configuration and the silent mock fallback.
 *
 * Two problems, one root cause — nothing could tell real embeddings from
 * hash stubs, and nothing could choose a provider:
 *
 *   1. Silent degradation. If transformers.js failed to load (offline, model
 *      not cached), initialize() warned once, set pipeline = null, and every
 *      subsequent embed() quietly returned mockEmbedding() — a deterministic
 *      hash with no semantic signal (it scored "authentication issues" vs
 *      "add authentication middleware" at -0.978). A database could fill with
 *      meaningless vectors and every recall return noise, with no error and no
 *      way to ask. `provider: 'openai'` without an apiKey did the same thing.
 *
 *   2. Unreachable config. EmbeddingService implements an 'openai' provider,
 *      but AgentDB hardcoded provider/model and AgentDBConfig had no
 *      provider/apiKey/model fields, so it could not be selected. `agentdb
 *      init --dimension/--model` wrote agentdb_config keys that only `status`
 *      ever read back, to print them.
 *
 * Note 'local' is NOT a local model — it is the hash stub. That naming trap is
 * why these tests assert on getActiveProvider() rather than the configured
 * provider.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EmbeddingService } from '../../src/controllers/EmbeddingService.js';
import { AgentDB } from '../../src/core/AgentDB.js';

const UNLOADABLE = 'agentdb-test/definitely-not-a-real-model';

describe('mock embeddings are never substituted silently', () => {
  it('throws when a real model fails to load instead of stubbing', async () => {
    const svc = new EmbeddingService({
      model: UNLOADABLE,
      dimension: 384,
      provider: 'transformers'
    });

    // The bug: this resolved, then every embed() returned hash noise.
    await expect(svc.initialize()).rejects.toThrow(/Refusing to fall back to mock/i);
  });

  it('throws for provider openai with no apiKey', async () => {
    const svc = new EmbeddingService({
      model: 'text-embedding-3-small',
      dimension: 1536,
      provider: 'openai'
    });

    await expect(svc.initialize()).rejects.toThrow(/requires an apiKey/i);
  });

  it('allows stubs only when explicitly opted in, and admits to it', async () => {
    const svc = new EmbeddingService({
      model: UNLOADABLE,
      dimension: 384,
      provider: 'transformers',
      allowMockFallback: true
    });

    await svc.initialize();

    expect(svc.isUsingMockEmbeddings()).toBe(true);
    expect(svc.getActiveProvider()).toBe('mock');
    // Still usable — opting in means accepting stubs, not breaking.
    expect((await svc.embed('hello')).length).toBe(384);
  });

  it('refuses to embed when a real provider never initialised', async () => {
    const svc = new EmbeddingService({
      model: UNLOADABLE,
      dimension: 384,
      provider: 'transformers'
    });

    // initialize() intentionally not called / failed: embed() must not
    // silently paper over it with stubs.
    await expect(svc.embed('hello')).rejects.toThrow(/not ready|Refusing/i);
  });

  it('reports a real local model as transformers, not mock', async () => {
    const svc = new EmbeddingService({
      model: 'Xenova/all-MiniLM-L6-v2',
      dimension: 384,
      provider: 'transformers'
    });

    await svc.initialize();
    expect(svc.isUsingMockEmbeddings()).toBe(false);
    expect(svc.getActiveProvider()).toBe('transformers');
  });
});

describe('OpenAI embedding errors are legible', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('reports HTTP failures instead of a TypeError on undefined', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
        statusText: 'Unauthorized'
      })) as typeof fetch;

    const svc = new EmbeddingService({
      model: 'text-embedding-3-small',
      dimension: 1536,
      provider: 'openai',
      apiKey: 'sk-invalid'
    });
    await svc.initialize();

    // The response was parsed without checking status, so a 401 surfaced as
    // "Cannot read properties of undefined (reading '0')".
    await expect(svc.embed('hello')).rejects.toThrow(/HTTP 401.*Incorrect API key/is);
  });

  it('rejects a model whose dimension disagrees with the database', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), {
        status: 200
      })) as typeof fetch;

    const svc = new EmbeddingService({
      model: 'text-embedding-3-small',
      dimension: 384, // wrong on purpose: the model returns 1536
      provider: 'openai',
      apiKey: 'sk-test'
    });
    await svc.initialize();

    // Otherwise this fails later, inside the vector index, far from its cause.
    await expect(svc.embed('hello')).rejects.toThrow(/dimension mismatch.*1536.*384/is);
  });
});

describe('AgentDB embedding provider is configurable', () => {
  it('defaults to the real local model', async () => {
    const db = new AgentDB({ dbPath: ':memory:', vectorBackend: 'hnswlib' });
    await db.initialize();

    expect(db.embeddingProvider).toBe('transformers');
    expect(db.usingMockEmbeddings).toBe(false);
    await db.close();
  });

  it('can select the openai provider, which AgentDBConfig could not express', async () => {
    const db = new AgentDB({
      dbPath: ':memory:',
      vectorBackend: 'hnswlib',
      vectorDimension: 1536,
      embedding: { provider: 'openai', apiKey: 'sk-test-not-used', model: 'text-embedding-3-small' }
    });
    await db.initialize();

    expect(db.embeddingProvider).toBe('openai');
    expect(db.usingMockEmbeddings).toBe(false);
    await db.close();
  });

  it('surfaces a missing openai key rather than stubbing', async () => {
    const db = new AgentDB({
      dbPath: ':memory:',
      vectorBackend: 'hnswlib',
      embedding: { provider: 'openai' }
    });

    // Guard against an ambient key making this a false pass.
    if (process.env.OPENAI_API_KEY) return;
    await expect(db.initialize()).rejects.toThrow(/requires an apiKey/i);
  });

  it('exposes mock usage so callers can detect meaningless vectors', async () => {
    const db = new AgentDB({
      dbPath: ':memory:',
      vectorBackend: 'hnswlib',
      embedding: { provider: 'local' }
    });
    await db.initialize();

    // There was previously no way to ask this from outside AgentDB.
    expect(db.usingMockEmbeddings).toBe(true);
    expect(db.embeddingProvider).toBe('mock');
    await db.close();
  });
});
