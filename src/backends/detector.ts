/**
 * Backend Detection - Auto-detect available vector backends
 *
 * Detection priority:
 * 1. RuVector (@ruvector/core) - preferred for performance
 * 2. HNSWLib (hnswlib-node) - stable fallback
 *
 * Additional features detected:
 * - @ruvector/gnn - GNN learning capabilities
 * - @ruvector/graph-node - Graph database capabilities
 */

/**
 * Backend type identifier
 */
export type BackendType = 'ruvector' | 'hnswlib' | 'auto';

/**
 * Platform information
 */
export interface PlatformInfo {
  /** Operating system */
  platform: NodeJS.Platform;

  /** CPU architecture */
  arch: string;

  /** Combined platform identifier (e.g., 'linux-x64', 'darwin-arm64') */
  combined: string;
}

/**
 * Backend detection result
 */
export interface DetectionResult {
  /** Detected backend type */
  backend: 'ruvector' | 'hnswlib';

  /** Available feature flags */
  features: {
    /** GNN learning available */
    gnn: boolean;

    /** Graph database available */
    graph: boolean;

    /** Compression available */
    compression: boolean;
  };

  /** Platform information */
  platform: PlatformInfo;

  /** Whether native bindings are available (vs WASM fallback) */
  native: boolean;

  /** Version information */
  versions?: {
    core?: string;
    gnn?: string;
    graph?: string;
  };
}

/**
 * RuVector availability check result
 */
interface RuVectorAvailability {
  available: boolean;
  native: boolean;
  gnn: boolean;
  graph: boolean;
  version?: string;
}

/**
 * Detect available vector backend and features
 *
 * @returns Detection result with backend type and available features
 */
export async function detectBackend(): Promise<DetectionResult> {
  // Get platform information
  const platform = getPlatformInfo();

  // Check for RuVector (preferred)
  const ruvectorAvailable = await checkRuVector();

  if (ruvectorAvailable.available) {
    return {
      backend: 'ruvector',
      features: {
        gnn: ruvectorAvailable.gnn,
        graph: ruvectorAvailable.graph,
        compression: true, // RuVector always supports compression
      },
      platform,
      native: ruvectorAvailable.native,
      versions: {
        core: ruvectorAvailable.version,
      },
    };
  }

  // Fallback to HNSWLib
  const hnswlibNative = await checkHnswlib();

  return {
    backend: 'hnswlib',
    features: {
      gnn: false,
      graph: false,
      compression: false,
    },
    platform,
    native: hnswlibNative,
  };
}

/**
 * Pull a version string off a RuVector module, whichever shape it uses.
 *
 * `ruvector` exposes getVersion() returning { version, implementation };
 * other builds expose a `version` field or function.
 */
function readRuVectorVersion(mod: any): string | null {
  if (!mod) return null;
  try {
    if (typeof mod.getVersion === 'function') {
      const v = mod.getVersion();
      const raw = typeof v === 'string' ? v : v?.version;
      if (raw) return String(raw);
    }
    if (typeof mod.version === 'function') {
      const v = mod.version();
      if (v) return String(typeof v === 'string' ? v : v?.version ?? v);
    }
    if (typeof mod.version === 'string') return mod.version;
  } catch {
    // A probe throwing is not a detection failure — just an unknown version.
  }
  return null;
}

/**
 * Check RuVector availability and features
 */
async function checkRuVector(): Promise<RuVectorAvailability> {
  try {
    // Resolve the same way RuVectorBackend does: the `ruvector` package first,
    // falling back to @ruvector/core. Probing only @ruvector/core reported
    // native=false and version='unknown' unconditionally — it exposes neither
    // isNative() nor version, while `ruvector` (the package actually loaded)
    // exposes both. The engine was native all along; the check was misdirected.
    let mod: any;
    try {
      mod = await import('ruvector');
    } catch {
      mod = await import('@ruvector/core');
    }
    const core: any = mod?.default ?? mod;

    // Check if native bindings are available. Probe the imported namespace
    // first — `ruvector` exposes isNative()/getVersion() at the top level,
    // while its `default` is the inner @ruvector/core module, which reports
    // the engine's own version rather than the package's.
    const native: boolean =
      typeof mod.isNative === 'function'
        ? mod.isNative() === true
        : typeof core.isNative === 'function'
          ? core.isNative() === true
          : false;

    // Get version. `ruvector` exposes getVersion(); older builds used a
    // `version` field or function.
    const version = readRuVectorVersion(mod) ?? readRuVectorVersion(core) ?? 'unknown';

    // Check for GNN support
    let gnn = false;
    try {
      await import('@ruvector/gnn');
      gnn = true;
    } catch {
      // GNN not available
    }

    // Check for Graph support
    let graph = false;
    try {
      await import('@ruvector/graph-node');
      graph = true;
    } catch {
      // Graph not available
    }

    return {
      available: true,
      native,
      gnn,
      graph,
      version,
    };
  } catch (error) {
    // RuVector not available
    return {
      available: false,
      native: false,
      gnn: false,
      graph: false,
    };
  }
}

/**
 * Check HNSWLib availability
 */
async function checkHnswlib(): Promise<boolean> {
  try {
    // Try to import hnswlib-node
    await import('hnswlib-node');
    return true;
  } catch (error) {
    console.warn('[AgentDB] HNSWLib not available:', error);
    return false;
  }
}

/**
 * Get platform information
 */
function getPlatformInfo(): PlatformInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    combined: `${process.platform}-${process.arch}`,
  };
}

/**
 * Validate requested backend is available
 *
 * @param requested - Requested backend type
 * @param detected - Detected backend from auto-detection
 * @throws Error if requested backend is not available
 */
export function validateBackend(
  requested: BackendType,
  detected: DetectionResult
): void {
  if (requested === 'auto') {
    // Auto-detection always succeeds
    return;
  }

  if (requested === 'ruvector' && detected.backend !== 'ruvector') {
    throw new Error(
      'RuVector backend requested but not available.\n' +
        'Install with: npm install @ruvector/core\n' +
        'See: https://github.com/ruvnet/ruvector'
    );
  }

  if (requested === 'hnswlib' && detected.backend !== 'hnswlib') {
    throw new Error(
      'HNSWLib backend requested but not available.\n' +
        'Install with: npm install hnswlib-node'
    );
  }
}

/**
 * Get recommended backend for a given use case
 *
 * @param useCase - Use case identifier
 * @returns Recommended backend type
 */
export function getRecommendedBackend(useCase: string): BackendType {
  const useCaseLower = useCase.toLowerCase();

  // RuVector recommended for advanced features
  if (
    useCaseLower.includes('learning') ||
    useCaseLower.includes('gnn') ||
    useCaseLower.includes('graph') ||
    useCaseLower.includes('compression')
  ) {
    return 'ruvector';
  }

  // Auto-detection for general use
  return 'auto';
}

/**
 * Format detection result for display
 *
 * @param result - Detection result
 * @returns Formatted string for console output
 */
export function formatDetectionResult(result: DetectionResult): string {
  const lines: string[] = [];

  lines.push('📊 Backend Detection Results:');
  lines.push('');
  lines.push(`  Backend:     ${result.backend}`);
  lines.push(`  Platform:    ${result.platform.combined}`);
  lines.push(`  Native:      ${result.native ? '✅' : '❌ (using WASM)'}`);
  lines.push(`  GNN:         ${result.features.gnn ? '✅' : '❌'}`);
  lines.push(`  Graph:       ${result.features.graph ? '✅' : '❌'}`);
  lines.push(`  Compression: ${result.features.compression ? '✅' : '❌'}`);

  if (result.versions?.core) {
    lines.push(`  Version:     ${result.versions.core}`);
  }

  lines.push('');

  // Add recommendations
  if (result.backend === 'hnswlib') {
    lines.push('💡 Tip: Install @ruvector/core for 150x faster performance');
    lines.push('   npm install @ruvector/core');
  } else if (!result.features.gnn) {
    lines.push('💡 Tip: Install @ruvector/gnn for adaptive learning');
    lines.push('   npm install @ruvector/gnn');
  }

  return lines.join('\n');
}
