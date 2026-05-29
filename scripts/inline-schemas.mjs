#!/usr/bin/env node
// Generate src/schemas/inline.ts from src/schemas/*.sql so AgentDB can load its
// schemas in environments where fs.readFileSync is unusable or unreliable —
// the browser (#2) and globally-installed CLIs where `__dirname` resolution
// misses the schema files (#1).
//
// Source of truth stays in src/schemas/*.sql. This script is wired into
// `prebuild`, so any edit to those files regenerates inline.ts on build.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, '..', 'src', 'schemas');
const OUT = join(SCHEMAS_DIR, 'inline.ts');

const schema = readFileSync(join(SCHEMAS_DIR, 'schema.sql'), 'utf-8');
const frontier = readFileSync(join(SCHEMAS_DIR, 'frontier-schema.sql'), 'utf-8');

// JSON.stringify produces a valid JS string literal that handles backticks,
// newlines, and any other special characters safely.
const out = `// GENERATED FILE — do not edit by hand.
// Source: src/schemas/schema.sql + frontier-schema.sql via scripts/inline-schemas.mjs.
//
// These are inlined as string constants so AgentDB.loadSchemas() works in:
//   - the browser (no fs / readFileSync available)
//   - globally-installed CLIs (where __dirname resolution misses /dist/schemas)
// See ruvnet/agentdb#1, #2.

export const SCHEMA_SQL = ${JSON.stringify(schema)};
export const FRONTIER_SCHEMA_SQL = ${JSON.stringify(frontier)};
`;

writeFileSync(OUT, out, 'utf-8');
console.log(`Wrote ${OUT} (${schema.length} + ${frontier.length} chars).`);
