# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed (correctness)

- **Interior insertion (sequence CRDTs).** `YArray`/`YText` inserts are now integrated with a right-origin (YATA/Fugue-style) rule bounded by both the left (`afterId`) and right (`beforeId`) neighbour. Previously any insert with index > 0 walked to the end of the sequence, so typing into the middle of text/array — even single-user — produced the wrong order, and concurrently-typed runs could interleave. Out-of-range insert indices now clamp to the end instead of the head.
- **`Doc.gc()`** now invalidates the walker's incremental undo-closure cache (`EgWalker.invalidateUndoCache()`). Without this, a garbage-collect followed by a late concurrent event could duplicate elements and permanently diverge a replica from its own history.
- **`UndoManager`** records an undo boundary even for groups whose operations are all non-invertible (formatting, container overwrite/delete). Previously such a group left no boundary, so a subsequent `undo()` destructively reverted an *older* group (e.g. undoing formatting deleted the underlying text).
- **Client snapshot reconcile** now preserves *all* already-integrated events a recovery snapshot is missing (including peer events), not just this replica's own, preventing silent data loss on reconnect.
- **Clock-poisoning defense.** `isCrdtEvent` bounds the Lamport sequence below the safe-integer ceiling, and `EgWalker.localOp` throws on a local id collision instead of silently dropping the event.

### Fixed (server durability)

- **`BufferedRepository.flush()`** now fully drains the buffer and coalesces concurrent callers, so events enqueued during an in-flight flush are no longer stranded and a shutdown flush no longer claims durability it has not achieved. Flush batches are epoch-tagged so a failed save cannot resurrect events an interleaved `clearEvents()` (compaction) removed.
- **Compaction** (`CrdtServer.compact()`) is routed through the message queue so it can no longer interleave with an in-flight event save (which could persist an event with dangling parents).
- **Idle eviction** is guarded by instance identity and its timer is cleared on reconnect, so a stale timer can no longer evict a fresh replacement instance for the same room.
- **Awareness** payloads are size-capped and the number of replica ids per socket is bounded (memory-growth DoS); offline awareness deletes its entry across the cluster instead of retaining null tombstones.

### Changed / migration notes

- **Wire format.** `text-insert` / `array-insert` operations carry an optional `beforeId` (right origin), and compaction `snapshot` operations carry an optional `folded` state-vector (replicaId → highest folded sequence) that the client reconcile uses to distinguish events folded into the snapshot (skip) from events the server lost (re-integrate). Legacy events/snapshots without these fields still integrate (open-ended right origin / empty vector). Because the integration rule changed, replaying an existing event history renders interior insertions in their corrected order — **all peers must run the same version** to stay converged. Snapshots and the persisted `op` column round-trip the new fields automatically.
- `CrdtClient.syncText` diffs on code-point boundaries, so emoji/astral edits no longer produce lone surrogates.

### Fixed (docs / infra)

- Corrected `INTEGRATION.md` (`handleWebSocket` arity, `saveEvents`, removed non-existent `doc.localInsert`), the core README `UndoManager` model, `agents.md` (vitest globals, `doc.js` import, `sqlite.db` path), and the demo README DB path + text-db variant.
- Fixed the vitest coverage `include` (the `src/server/**` tree was excluded via a stale path), reinstated `workers: 1` for the e2e suite, added a demo `type-check` script (now covered by `pnpm -r run type-check`), and reordered the package `exports` conditions (`types` before `import`).

---

## [0.2.0] - 2026-06-14

### Added

- **`CrdtServer`** — reusable server-side WebSocket synchronization engine, extracted from the demo into `packages/core/src/server/crdtServer.ts`. Provides multi-room support with pluggable repository and PubSub adapters.
- **`CrdtClient`** — new client abstraction (`packages/core/src/crdtClient.ts`) that encapsulates WebSocket connection management, CRDT event dispatching, and `EventEmitter` integration. Includes a `syncText` utility to centralize character-level diff logic so consumers no longer implement it manually.
- **PubSub adapters** — `IPubSubAdapter` interface with two implementations:
  - `InMemoryPubSubAdapter` for single-process use
  - `RedisPubSubAdapter` for clustered, multi-instance deployments (`packages/core/src/server/redisPubSubAdapter.ts`)
- **`BufferedRepository`** — write-buffering layer around any `ICrdtRepository` that batches DB writes for improved throughput (`packages/core/src/server/bufferedRepository.ts`).
- **Multi-room support** — events are now partitioned by `roomId` in both the database schema and WebSocket routing.
- **`text-db` demo** — a new demo variant where collaborative CRDT events are managed in-memory and only the compiled text content is persisted to SQLite (`packages/demo/interactive-test/text-db.{html,ts}`). Accompanied by a new E2E spec (`packages/demo/e2e/text-db.spec.ts`).
- **DB migration `0001`** — adds the `rooms` table alongside the existing events table.
- **Comprehensive test suites** — new unit tests for `CrdtClient`, `CrdtServer`, `BufferedRepository`, and `PubSubAdapter`.
- **`agents.md`** — developer and agent guide documenting project structure, workflow, testing patterns, and coding standards.
- **Package-level READMEs** — dedicated `README.md` for `packages/core` and `packages/demo`, plus an updated `INTEGRATION.md` with detailed usage examples.
- **`sync.ts`** — shared sync-protocol types moved to `packages/core/src/sync.ts` and re-exported from the package root.

### Changed

- **Package consolidation** — the separate `@ddgll/ts-crdt-client` and `@ddgll/ts-crdt-server` packages have been merged back into `@ddgll/ts-crdt` (core), exposed via subpath exports (`@ddgll/ts-crdt/client`, `@ddgll/ts-crdt/server`).
- **File naming** — all source files renamed from `PascalCase` to `camelCase` (e.g., `YMap.ts` → `yMap.ts`, `Doc.ts` → `doc.ts`) for consistency.
- **Demo server refactored** — `InMemoryTextRepository` and `RoomRepository` extracted into standalone files; database configuration centralised in `packages/demo/server/db.ts`.
- **Test suite harmonised** — all `test(...)` calls converted to `describe`/`it` blocks per project conventions.
- **`interactive-test` clients simplified** — text-diff logic removed from `main.ts` and `rich.ts` and delegated to `CrdtClient.syncText`.
- **`EgWalker` extended** — `EventEmitter` support added so external listeners can react to local and remote events.

### Refactored

- Extracted server-side CRDT logic (WebSocket handling, event routing, persistence) from the demo into a dedicated `CrdtServer` class.
- Removed the now-redundant raw WebSocket type assertion in the server handler.

---

## [0.1.3] - 2026-06-13

### Added

- Fix text operations and stabilise the core CRDT engine.
- Version bump across all packages.

---

## [0.1.1] - 2026-06-12

### Fixed

- Bug fixes and miscellaneous improvements.

---

## [0.1.0] - 2026-06-11

### Added

- Initial release of `@ddgll/ts-crdt`.
- Core CRDT data structures: `YMap`, `YArray`, `YText`.
- DAG-based `EventGraph` and `EgWalker` engine.
- Collaborative rich-text editor demo with WebSocket sync and SQLite persistence (LibSQL + Drizzle ORM).
