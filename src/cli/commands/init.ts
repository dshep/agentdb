/**
 * AgentDB Init Command - Initialize database with backend detection
 */

import { detectBackend, formatDetectionResult, type DetectionResult } from '../../backends/detector.js';
import { createDatabase } from '../../db-fallback.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Color codes for beautiful output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

interface InitOptions {
  backend?: 'auto' | 'ruvector' | 'hnswlib';
  dimension?: number;
  model?: string;
  /**
   * Where embeddings are computed:
   *   'transformers' — locally, in-process (default)
   *   'openai'       — remotely, via api.openai.com; needs OPENAI_API_KEY
   *   'local'        — hash stub, for tests only
   *
   * Recorded so later commands don't try to load, say, an OpenAI model
   * through transformers.js.
   */
  provider?: 'transformers' | 'openai' | 'local';
  preset?: 'small' | 'medium' | 'large';
  inMemory?: boolean;
  dryRun?: boolean;
  dbPath?: string;
}

function printDetectionInfo(detection: DetectionResult): void {
  console.log(`\n${colors.bright}${colors.cyan}🔍 AgentDB v2 - Backend Detection${colors.reset}\n`);
  console.log(formatDetectionResult(detection));
}

function getBackendColor(backend: 'ruvector' | 'hnswlib'): string {
  return backend === 'ruvector' ? colors.green : colors.yellow;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const {
    backend = 'auto',
    dimension = 384,
    model,
    provider = 'transformers',
    preset,
    inMemory = false,
    dryRun = false,
    dbPath = './agentdb.db'
  } = options;

  try {
    // Detect available backends
    const detection = await detectBackend();

    if (dryRun) {
      printDetectionInfo(detection);
      return;
    }

    // Validate backend selection
    if (backend === 'ruvector' && detection.backend !== 'ruvector') {
      console.error(`${colors.red}❌ Error: RuVector not available${colors.reset}`);
      console.error(`   Install with: ${colors.cyan}npm install @ruvector/core${colors.reset}`);
      process.exit(1);
    }

    if (backend === 'hnswlib' && detection.backend !== 'hnswlib') {
      console.error(`${colors.red}❌ Error: HNSWLib not available${colors.reset}`);
      console.error(`   Install with: ${colors.cyan}npm install hnswlib-node${colors.reset}`);
      process.exit(1);
    }

    // Determine actual backend to use
    const selectedBackend = backend === 'auto' ? detection.backend : backend;

    // Determine actual database path (handle in-memory)
    const actualDbPath = inMemory ? ':memory:' : dbPath;

    // Determine embedding model (with provider- and dimension-aware defaults)
    const embeddingModel =
      model ||
      (provider === 'openai'
        ? 'text-embedding-3-small'
        : provider === 'local'
          ? 'mock-model'
          : dimension === 768
            ? 'Xenova/bge-base-en-v1.5'
            : 'Xenova/all-MiniLM-L6-v2');

    // A remote model cannot be loaded by transformers.js, and a HuggingFace id
    // means nothing to the OpenAI API. Catch the mismatch here rather than at
    // first use, several commands later.
    if (provider === 'transformers' && /^text-embedding-/.test(embeddingModel)) {
      throw new Error(
        `Model '${embeddingModel}' is an OpenAI model and cannot run locally.\n` +
        `Use: agentdb init --provider openai --model ${embeddingModel} --dimension 1536\n` +
        `(and set OPENAI_API_KEY), or pick a local model such as Xenova/all-MiniLM-L6-v2.`
      );
    }
    if (provider === 'openai' && embeddingModel.startsWith('Xenova/')) {
      throw new Error(
        `Model '${embeddingModel}' is a local HuggingFace model; the OpenAI API cannot serve it.\n` +
        `Use --provider transformers, or an OpenAI model such as text-embedding-3-small.`
      );
    }

    console.log(`\n${colors.bright}${colors.cyan}🚀 Initializing AgentDB${colors.reset}\n`);
    console.log(`  Database:      ${colors.blue}${actualDbPath}${colors.reset}`);
    console.log(`  Backend:       ${getBackendColor(selectedBackend)}${selectedBackend}${colors.reset}`);
    console.log(`  Dimension:     ${colors.blue}${dimension}${colors.reset}`);
    console.log(
      `  Embeddings:    ${colors.blue}${provider}${colors.reset} ` +
      (provider === 'openai'
        ? '(remote — sent to api.openai.com)'
        : provider === 'local'
          ? '(MOCK hash stub — no semantic meaning)'
          : '(local, in-process)')
    );
    console.log(`  Model:         ${colors.blue}${embeddingModel}${colors.reset}`);
    if (preset) {
      console.log(`  Preset:        ${colors.blue}${preset}${colors.reset}`);
    }
    console.log('');

    // Initialize database
    const db = await createDatabase(actualDbPath);

    // Configure for performance
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');

    // Load schemas (use package dist directory, not cwd)
    // When running from dist/src/cli/commands/init.js, schemas are in dist/schemas/
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // __dirname is dist/src/cli/commands, so go up 3 levels to dist/
    const distDir = path.join(__dirname, '../../..');
    const basePath = path.join(distDir, 'schemas');
    const schemaFiles = ['schema.sql', 'frontier-schema.sql'];

    for (const schemaFile of schemaFiles) {
      const schemaPath = path.join(basePath, schemaFile);
      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        db.exec(schema);
      } else {
        console.warn(`${colors.yellow}⚠ Warning: Schema file not found: ${schemaPath}${colors.reset}`);
      }
    }

    // Store backend configuration
    db.prepare(`
      CREATE TABLE IF NOT EXISTS agentdb_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO agentdb_config (key, value)
      VALUES (?, ?)
    `).run('backend', selectedBackend);

    db.prepare(`
      INSERT OR REPLACE INTO agentdb_config (key, value)
      VALUES (?, ?)
    `).run('dimension', dimension.toString());

    db.prepare(`
      INSERT OR REPLACE INTO agentdb_config (key, value)
      VALUES (?, ?)
    `).run('embedding_model', embeddingModel);

    // Record where embeddings are computed. Without it, later commands assume
    // transformers.js and try to load remote-only models (text-embedding-3-*)
    // from HuggingFace, which cannot work.
    db.prepare(`
      INSERT OR REPLACE INTO agentdb_config (key, value)
      VALUES (?, ?)
    `).run('embedding_provider', provider);

    if (preset) {
      db.prepare(`
        INSERT OR REPLACE INTO agentdb_config (key, value)
        VALUES (?, ?)
      `).run('preset', preset);
    }

    db.prepare(`
      INSERT OR REPLACE INTO agentdb_config (key, value)
      VALUES (?, ?)
    `).run('version', '2.0.0');

    db.close();

    console.log(`${colors.green}✅ AgentDB initialized successfully${colors.reset}\n`);

    if (selectedBackend === 'ruvector' && detection.features.gnn) {
      console.log(`${colors.bright}${colors.magenta}🧠 Bonus:${colors.reset} GNN self-learning available`);
      console.log(`   Use ${colors.cyan}agentdb train${colors.reset} to enable adaptive patterns\n`);
    }

    if (selectedBackend === 'hnswlib') {
      console.log(`${colors.yellow}💡 Tip:${colors.reset} Install RuVector for 150x performance boost`);
      console.log(`   ${colors.cyan}npm install @ruvector/core${colors.reset}\n`);
    }

  } catch (error) {
    console.error(`${colors.red}❌ Initialization failed:${colors.reset}`);
    console.error(`   ${(error as Error).message}`);
    process.exit(1);
  }
}
