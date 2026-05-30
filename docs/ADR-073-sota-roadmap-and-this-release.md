# ADR-073 — SOTA Roadmap and Release-Round Commitments

**Status**: Accepted — Implemented in agentdb 3.0.0-alpha.16
**Date**: 2026-05-29
**Tracking issue**: [#6](https://github.com/ruvnet/agentdb/issues/6) — SOTA roadmap
**Companion**: ADR-072 (Phase 1 benchmark results — many targets still marked TBD; this ADR delivers the harness that replaces TBDs with measured numbers)

## Context

A 5-axis deep review of `agentdb@3.0.0-alpha.15` ran against modern SOTA reference points:

- **Vector DBs**: Qdrant 1.6+, Weaviate, LanceDB, Milvus, Chroma, sqlite-vss/libsql-vector
- **Agent memory**: ReasoningBank, Reflexion, MemGPT, Letta, Generative Agents
- **Retrieval**: ColBERT late-interaction, RRF hybrid fusion, MMR diversity
- **Causal**: doubly-robust estimation (Chernozhukov 2018), backdoor/frontdoor criteria
- **Quantization**: RaBitQ (1-bit), PQ8/PQ4

The review found agentdb already has a strong stack — verified 150× HNSW vs SQLite, real doubly-robust causal math, 9-algorithm RL framework, MMR + HybridSearch + ExplainableRecall classes, 33 MCP tools, and a maintained security baseline (recent SQL-injection / CVE / PRNG remediation commits). But:

- Many **claimed** numbers (32× memory, 36% recall uplift, 95% recall@10) are **unmeasured** in committed artifacts.
- Several SOTA-grade primitives **exist internally but aren't reachable via MCP** (causal traversal, MMR rerank, hybrid search, skill lifecycle, consolidate-on-demand).
- A few **HIGH-severity** security gaps remain in spite of the recent hardening sweep (unguarded `JSON.parse`, template-literal SQL identifiers, `Math.random()` IDs).

## Decision

Ship this release as **agentdb 3.0.0-alpha.16** with the high-leverage / low-effort intersection of the four review axes. Treat the bigger items (RaBitQ, learned reranking, tier-aware memory, async HNSW rebuild, worker-thread pool) as **tracked-only** and document them in #6 so they don't get forgotten — but don't pack them into this round.

Every shipped item lands with a regression test in `tests/` so it runs under `npm run test:unit` (which is now part of `test:ci` per #3).

### A. Honest measurement
1. **Recall@k benchmark harness** (`scripts/benchmark-recall.mjs` + `bench-data/recall-corpus.json`) — measures recall@1/10/100 for HNSW vs brute-force across a fixed corpus. Writes a run JSON to `docs/benchmarks/runs/` so claims become verifiable, not aspirational.
2. **Qualify unverified claims** in README/docs — anything not in a committed run JSON gets marked "estimated" or removed.

### B. MCP exposure of existing internals
3. **`causal_traverse`** — walks the causal graph backward/forward from a memory ID with configurable max-hops + min-confidence. Wraps `CausalMemoryGraph` (existing).
4. **`agentdb_search` modes** — adds `search_mode: 'vector' | 'keyword' | 'hybrid'` and `diversity_penalty: 0.0–1.0` (MMR λ). Wraps `MMRDiversityRanker` and `HybridSearch` (both existing).
5. **`agentdb_delete_batch`** — bulk delete by ID list in one transaction.
6. **`skill_promote` / `skill_archive`** — lifecycle on `SkillLibrary` (mark high-value skills, hide weak ones from retrieval without deleting).
7. **`consolidate_now`** — on-demand wrapper around `NightlyLearner.run()`. The full "background worker" item is bigger and stays in #6.

### C. Security hardening
8. **`safeJsonParse<T>(json, fieldName)`** applied to every CLI / MCP user-input parse site. Wraps `JSON.parse` in a try/catch that throws a `ValidationError` with a safe message — no stack-trace leak, no DoS via crafted input. Continues the precedent set in commit `026011e`.
9. **`validateSqlIdentifier()` on every remaining template-literal SQL** — closes the residual CWE-89 surface in `migrate.ts:502`, `learning-tools-handlers.ts:33/41`, and any other site where a SQL fragment is assembled rather than parameterized.
10. **Standardize ID generation** to `crypto.randomBytes(8).toString('hex')` — replaces `Math.random().toString(36)` in `agentdb-fast.ts:383`, `quic.ts:734`, `GraphDatabaseAdapter.ts:162/187`.

## Deliberately NOT in this round

Listed in #6 with effort estimates; deferred because they cross the 1-week single-PR budget for this round:

- **RaBitQ 1-bit quantization** (3–4 wk) — would justify the existing 32× claim
- **Worker-thread batch-ingest pool** (1–2 wk) — 2–3× ingest throughput
- **Async HNSW incremental rebuild** (2–3 wk) — kills insert-latency spikes
- **Learned cross-encoder reranking head** (16–20 wk) — replaces fixed α/β/γ in `recall_with_certificate`
- **Tier-aware memory + EWC wiring** (8–10 wk) — episodic/working/long-term tiers + protected skill updates
- **Background consolidation worker** (4–6 wk) — full cron/budget version of #7
- **Graph-RAG multi-hop traversal in retrieval** (6–8 wk) — beyond exposure (#3), make traversal a first-class retrieval step

## Consequences

- **Verifiable performance story** — every perf claim in the README will be backed by a committed run JSON or marked as a target.
- **MCP surface jumps from 33 → ~38 tools**, all wrapping internals that already work. Agent discoverability improves materially: causal explanation, diversity, hybrid search, lifecycle, on-demand consolidation.
- **Three HIGH-severity security gaps closed**; one MED gap (Math.random IDs) closed across all known sites.
- **Honest README** — "32×" gets either backed by RaBitQ measurement (future round) or qualified as a target.

## Verification

- `tests/recall-benchmark-harness.test.ts` — recall@k corpus runs deterministically; asserts a floor (e.g., recall@10 ≥ 0.90 for the seeded corpus on HNSW). This becomes the gate that breaks if quantization or indexing regresses recall.
- `tests/mcp-causal-traverse.test.ts`, `tests/mcp-search-modes.test.ts`, `tests/mcp-delete-batch.test.ts`, `tests/mcp-skill-lifecycle.test.ts`, `tests/mcp-consolidate-now.test.ts` — each new MCP tool gets a handler test that proves it does what it claims.
- `tests/security-hardening-073.test.ts` — covers `safeJsonParse` rejection of crafted input, `validateSqlIdentifier` rejection of injection attempts, and a property test that `generateId()` is no longer reachable from `Math.random()`.
- `test:ci` (already includes `test:unit` per #3) gates everything in CI.
