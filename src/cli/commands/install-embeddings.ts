/**
 * AgentDB Install Embeddings Command
 * Install optional embedding dependencies (@xenova/transformers + onnxruntime)
 */

import { spawnSync } from 'child_process';

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

interface InstallEmbeddingsOptions {
  global?: boolean;
  /** Model to warm into the local cache (default: the one AgentDB uses). */
  model?: string;
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * Actually fetch the model weights into the local cache.
 *
 * This command used to install @xenova/transformers and then merely print
 * "First run will download model (~90MB)" — it downloaded nothing. Since the
 * model is not bundled into the package (too large to ship), this is the only
 * way to prepare a machine that will later be offline, and it is what the
 * embedding error messages point users at. So do the download rather than
 * describe it.
 */
async function warmModelCache(model: string): Promise<boolean> {
  console.log(`\n${colors.cyan}⬇️  Downloading model into local cache:${colors.reset} ${model}`);
  console.log(`   (~23MB quantized — one time; subsequent runs work offline)`);

  try {
    const { EmbeddingService } = await import('../../controllers/EmbeddingService.js');
    const embedder = new EmbeddingService({
      model,
      dimension: 384,
      provider: 'transformers'
    });
    await embedder.initialize();

    // Force a real inference so tokenizer + weights are both fetched, not just
    // the config. A resolvable model that can't actually embed is not "ready".
    const probe = await embedder.embed('warm the cache');

    if (embedder.isUsingMockEmbeddings()) {
      console.log(`${colors.red}❌ Model did not load — embeddings would be mock hash stubs${colors.reset}`);
      return false;
    }

    console.log(`${colors.green}✅ Model cached and verified${colors.reset} (${probe.length}-dim embeddings)`);
    return true;
  } catch (err) {
    console.log(`${colors.red}❌ Model download failed:${colors.reset} ${(err as Error).message.split('\n')[0]}`);
    console.log(`   Check network access, or set HUGGINGFACE_API_KEY if the model is gated.`);
    return false;
  }
}

export async function installEmbeddingsCommand(options: InstallEmbeddingsOptions = {}): Promise<void> {
  console.log(`\n${colors.bright}${colors.cyan}🧠 Installing AgentDB Embedding Dependencies${colors.reset}\n`);

  try {
    // Check if already installed
    try {
      require.resolve('@xenova/transformers');
      console.log(`${colors.yellow}⚠️  @xenova/transformers is already installed${colors.reset}`);
      console.log(`   Checking for updates...`);
    } catch (e) {
      console.log(`${colors.blue}ℹ Installing @xenova/transformers...${colors.reset}`);
    }

    // Determine npm args (avoid shell string interpolation — use array form)
    const npmArgs = options.global
      ? ['install', '-g', '@xenova/transformers']
      : ['install', '@xenova/transformers'];

    console.log(`\n${colors.cyan}📦 Installing optional dependencies:${colors.reset}`);
    console.log(`   - @xenova/transformers (ML models)`);
    console.log(`   - onnxruntime-node (native inference)`);
    console.log('');

    // Install dependencies using spawnSync with args array to prevent shell injection
    try {
      const result = spawnSync('npm', npmArgs, {
        stdio: 'inherit',
        cwd: process.cwd(),
        shell: false
      });
      if (result.status !== 0) {
        throw new Error(`npm exited with code ${result.status ?? 'unknown'}`);
      }

      console.log(`\n${colors.green}✅ Embedding dependencies installed successfully${colors.reset}`);

      // Installing the library is not the slow or fragile part — fetching the
      // weights is. Do it now, while we presumably have network, instead of
      // deferring it to whenever the user first tries to embed something.
      const model = options.model || DEFAULT_MODEL;
      const warmed = await warmModelCache(model);

      if (!warmed) {
        console.log('');
        console.log(`${colors.yellow}The library is installed but the model is not cached.${colors.reset}`);
        console.log(`   AgentDB will fail on first embed rather than silently produce`);
        console.log(`   meaningless vectors. Re-run this command with network access.`);
        console.log('');
        process.exit(1);
      }

      console.log('');
      console.log(`${colors.bright}${colors.magenta}🎉 Next Steps:${colors.reset}`);
      console.log(`   1. Restart your AgentDB instance`);
      console.log(`   2. Real embeddings will be used automatically — no further downloads`);
      console.log('');
      console.log(`${colors.cyan}💡 Tip:${colors.reset} Set ${colors.yellow}AGENTDB_MODEL_PATH${colors.reset} to share one model dir across machines`);
      console.log(`${colors.cyan}💡 Tip:${colors.reset} Set ${colors.yellow}HUGGINGFACE_API_KEY${colors.reset} for gated models`);
      console.log('');

    } catch (installError) {
      console.error(`${colors.red}❌ Installation failed:${colors.reset}`);
      console.error(`   ${(installError as Error).message}`);
      console.log('');
      console.log(`${colors.yellow}Troubleshooting:${colors.reset}`);
      console.log(`   - Ensure you have build tools installed (python3, make, g++)`);
      console.log(`   - On Alpine Linux: apk add --no-cache python3 make g++ gcompat`);
      console.log(`   - On Debian/Ubuntu: apt-get install python3 build-essential`);
      console.log(`   - On macOS: xcode-select --install`);
      process.exit(1);
    }

  } catch (error) {
    console.error(`${colors.red}❌ Command failed:${colors.reset}`);
    console.error(`   ${(error as Error).message}`);
    process.exit(1);
  }
}
