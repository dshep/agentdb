/**
 * Regression tests for ModelCacheLoader path resolution and env scoping.
 *
 * resolve() hardcoded an extra 'Xenova' path segment and expected a bare model
 * id, but every caller passes the full HuggingFace id. Lookups therefore
 * became '<root>/Xenova/Xenova/all-MiniLM-L6-v2' and always missed, so
 * resolve() returned null for the default model — silently disabling
 * AGENTDB_MODEL_PATH and the bundled .rvf, the two things it exists for. The
 * breakage stayed invisible because transformers keeps its own .cache and
 * consults it regardless, so ordinary runs still worked.
 *
 * Passing a bare id was worse than useless: resolve() matched, but returned a
 * localPath one directory above where transformers looks for a bare id — and
 * having set allowRemoteModels = false, the load could not recover. That is
 * the "file was not found locally" that tests/mcp-tools.test.ts hit.
 *
 * The env is also transformers' process-wide singleton, so pinning it for one
 * model leaked to every EmbeddingService created afterwards.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelCacheLoader } from '../../src/model/ModelCacheLoader.js';
import { EmbeddingService } from '../../src/controllers/EmbeddingService.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** The model must already be in the transformers cache for these to be meaningful. */
const cacheRoot = path.join(
  process.cwd(),
  'node_modules',
  '@xenova',
  'transformers',
  '.cache'
);
const haveCachedModel = fs.existsSync(
  path.join(cacheRoot, DEFAULT_MODEL, 'onnx', 'model_quantized.onnx')
);

const tmpDirs: string[] = [];
afterEach(() => {
  delete process.env.AGENTDB_MODEL_PATH;
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('ModelCacheLoader resolves the id it is given', () => {
  it('finds the default model by its full id', async () => {
    if (!haveCachedModel) return;

    // The bug: null, because it looked under <cache>/Xenova/Xenova/...
    const result = await ModelCacheLoader.resolve(DEFAULT_MODEL);
    expect(result).not.toBeNull();
    expect(result!.localPath).toBe(cacheRoot);
  });

  it('honours AGENTDB_MODEL_PATH, which was silently ignored', async () => {
    if (!haveCachedModel) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-modelpath-'));
    tmpDirs.push(dir);
    // Layout as documented: $AGENTDB_MODEL_PATH/Xenova/<model>/onnx/...
    fs.cpSync(path.join(cacheRoot, DEFAULT_MODEL), path.join(dir, DEFAULT_MODEL), {
      recursive: true
    });
    process.env.AGENTDB_MODEL_PATH = dir;

    const result = await ModelCacheLoader.resolve(DEFAULT_MODEL);
    expect(result?.localPath).toBe(dir);
  });

  it('is not limited to Xenova-org models', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-org-'));
    tmpDirs.push(dir);
    // A non-Xenova ONNX model, laid out under its own org.
    const modelId = 'Supabase/gte-small';
    fs.mkdirSync(path.join(dir, modelId, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(dir, modelId, 'onnx', 'model_quantized.onnx'), 'stub');
    process.env.AGENTDB_MODEL_PATH = dir;

    // The hardcoded 'Xenova' segment made every other org unresolvable.
    const result = await ModelCacheLoader.resolve(modelId);
    expect(result?.localPath).toBe(dir);
  });

  it('returns null for an unknown model rather than a bad path', async () => {
    const result = await ModelCacheLoader.resolve('Nobody/does-not-exist-xyz');
    expect(result).toBeNull();
  });
});

describe('EmbeddingService does not leak transformers env globally', () => {
  it('restores env after building a pipeline', async () => {
    if (!haveCachedModel) return;

    const transformers: any = await import('@xenova/transformers');
    const env = transformers.env;
    const before = {
      allowRemoteModels: env.allowRemoteModels,
      localModelPath: env.localModelPath,
      cacheDir: env.cacheDir
    };

    const svc = new EmbeddingService({
      model: DEFAULT_MODEL,
      dimension: 384,
      provider: 'transformers'
    });
    await svc.initialize();

    // The bug: allowRemoteModels stayed false and localModelPath stayed pinned
    // to this model's tree, so the next EmbeddingService for a different model
    // could not download it.
    expect(env.allowRemoteModels).toBe(before.allowRemoteModels);
    expect(env.localModelPath).toBe(before.localModelPath);
    expect(env.cacheDir).toBe(before.cacheDir);
  });

  it('lets a second service load a different model afterwards', async () => {
    if (!haveCachedModel) return;

    const a = new EmbeddingService({
      model: DEFAULT_MODEL,
      dimension: 384,
      provider: 'transformers'
    });
    await a.initialize();

    const b = new EmbeddingService({
      model: 'Xenova/all-MiniLM-L12-v2',
      dimension: 384,
      provider: 'transformers'
    });
    await b.initialize();

    expect(b.getActiveProvider()).toBe('transformers');
    expect(b.isUsingMockEmbeddings()).toBe(false);
    expect((await b.embed('hello')).length).toBe(384);
  });
});
