# Memory lifecycle for backends — what consumers must know

> **TL;DR.** Every `new SqlJsRvfBackend()` whose `initialize()` you call MUST be paired with `close()`, or its underlying MEMFS file leaks for the lifetime of the process. The wrapper getting GC'd is not enough. As of agentdb 3.0.0-alpha.17 a `FinalizationRegistry` provides a safety net, but explicit `close()` remains the contract.

## The MEMFS-singleton trap

`SqlJsRvfBackend` is built on top of [sql.js](https://github.com/sql-js/sql.js), which is an Emscripten port of SQLite to WebAssembly. The Emscripten module is a **process-global singleton**: every `new SQL.Database(buffer)` allocates a file inside the module's in-memory filesystem (MEMFS), and that file is only removed when `db.close()` calls `FS.unlink`.

Diagram of what's actually retained:

```
your code
  └── new SqlJsRvfBackend(...)
        └── this.db = new SQL.Database(buffer)
              └── MEMFS file "dbfile_<random>" of size ≈ sizeof(database)
                    ↑
                    │ held by the sql.js module's FS.nodes array
                    │ (module-level — outlives any wrapper)
```

When your JS code drops the reference to the `SqlJsRvfBackend` wrapper:

- V8 GC reclaims the wrapper object: **yes**
- V8 GC reclaims `this.db` (the sql.js Database object): **yes**
- The MEMFS file under that Database: **NO** — `FS.nodes` still holds it, and only `close()` calls `FS.unlink`

This is invisible in `process.memoryUsage().heapUsed`. The signature of a leak is **unbounded growth in `external` / `arrayBuffers`** while `heapUsed` stays flat.

## Downstream incident — ruvnet/ruflo#2432

A consumer's long-running `mcp start` process leaked **~36 GB over 6 weeks**, ~11 MB per orphaned wrapper (each = sizeof their `memory.db`). Heap snapshot retainer chain:

```
JSArrayBufferData (11.0 MB × 203 instances = 2.2 GB)
  ← Buffer
  ← MEMFS node.contents
  ← FS.nodes (sql.js module singleton)
  ← SqlJsRvfBackend.db
  ← ReflexionMemory.vectorBackend
  ← ControllerRegistry.controllers (Map)
```

Root cause in the consumer: a `Map.set(name, ...)` replaced controller entries without first calling `.close()` on the prior backend. The wrappers GC'd; the MEMFS files did not.

## What you (the consumer) must do

### Always call `close()` explicitly

```ts
const backend = new SqlJsRvfBackend({ dimension: 384, storagePath: '/path/to/db.rvf' });
await backend.initialize();
try {
  // ... use backend ...
} finally {
  backend.close();  // releases the MEMFS file AND flushes pending writes + saves
}
```

### Long-running processes: dispose on shutdown

```ts
process.on('beforeExit', () => {
  for (const b of allBackends) b.close();
});
```

### When you replace a backend, close the prior one

```ts
// WRONG — leaks the prior backend's MEMFS file
controllers.set(name, newBackend);

// RIGHT — close before replacing
const prior = controllers.get(name);
if (prior?.backend?.close) await prior.backend.close();
controllers.set(name, newBackend);
```

## The safety net (since 3.0.0-alpha.17)

`SqlJsRvfBackend` registers each open `db` with a module-level `FinalizationRegistry`. When the JS wrapper is GC'd without `.close()` having been called, the finalizer runs and closes the underlying sql.js Database. This reclaims the MEMFS file.

**Important caveats:**

1. **Non-deterministic timing.** V8's finalizer queue runs when V8 chooses, which can be seconds to minutes after the wrapper becomes unreachable. Long-running processes that allocate fast can still grow significantly before the finalizer catches up.
2. **No save.** The finalizer only closes — it does NOT call `db.export()` to persist pending writes. Explicit `close()` is the only way to guarantee durability.
3. **Not a substitute for the contract.** If you rely on the finalizer instead of explicit `close()`, your code is racing GC against your peak load. Don't.

## Detection

For monitoring dashboards:

```ts
import { SqlJsRvfBackend } from 'agentdb';

setInterval(() => {
  const open = SqlJsRvfBackend.openCount();
  const external = (process.memoryUsage().external / 1024 / 1024).toFixed(0);
  console.log(`[memfs] openBackends=${open}  external=${external}MB`);
}, 30_000);
```

Alert when `openCount()` grows without bound relative to your expected backend cardinality (typically: # of controllers × # of databases per controller).

## References

- Downstream incident: [ruvnet/ruflo#2432](https://github.com/ruvnet/ruflo/issues/2432)
- Downstream fix (close-on-replace in caller): [ruvnet/ruflo#2444](https://github.com/ruvnet/ruflo/pull/2444)
- Upstream tracking issue: [ruvnet/agentdb#9](https://github.com/ruvnet/agentdb/issues/9)
- sql.js MEMFS docs: https://emscripten.org/docs/api_reference/Filesystem-API.html
