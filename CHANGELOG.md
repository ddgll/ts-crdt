# Changelog

## [1.0.1] - 2025-10-06

### Changed

- **API Documentation (TSDoc)**: Added comprehensive TSDoc comments to all
  exported classes, methods, and types in the `packages/core` source code. This
  improves developer experience by providing better autocompletion and inline
  documentation in code editors.

## [1.0.0] - 2025-10-03

This is the first major release of the `@ddgll/ts-crdt` library after a
significant refactoring and stabilization effort. The library is now a robust,
event-driven CRDT implementation suitable for building real-time collaborative
applications.

### Added

- **Monorepo Structure**: The repository has been restructured into a monorepo
  with a `core` library package and a `demo` package.
- **`YText` CRDT**: A new shared data type for collaborative rich-text editing,
  supporting text insertion and formatting.
- **`UndoManager`**: A new class for managing undo and redo operations.
- **Awareness/Presence**: Implemented `setAwareness` and `getAwareness` methods
  for managing ephemeral client state.
- **History Traversal**: Added `rebuildStateAtVersion` to allow viewing
  historical snapshots of the document.
- **Version Management**: Implemented `getLastCriticalVersion` and
  `getChangesSince` for advanced synchronization and persistence strategies.
- **Comprehensive Test Suite**: Added extensive tests for all new and existing
  features, achieving high test coverage.

### Changed

- **Consolidated Documentation**: The documentation has been completely
  overhauled into a single, comprehensive `README.md` file.
- **`topologicalSort`**: Re-implemented the topological sort algorithm to be
  more robust and correct.
- **`YMap.set`**: The `set` method on `YMap` now returns the generated
  `CrdtEvent`.

### Removed

- **Obsolete Functions**: Removed all "NOK" functions from the old,
  text-editing-specific implementation. The `README.md` has been updated to
  reflect the new, streamlined API.
- **Redundant Documentation**: Deleted `DOCUMENTATION.md` and moved
  `INTEGRATION.md` to the `demo` package.
