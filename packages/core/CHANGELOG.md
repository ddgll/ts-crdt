# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
