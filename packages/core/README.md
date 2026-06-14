# @ddgll/ts-crdt (Core Library)

A modern, event-driven, DAG-based CRDT (Conflict-free Replicated Data Type) library for building real-time collaborative applications in TypeScript.

## Key Features

- **Event-Driven Architecture**: Mutating operations generate immutable events stored in a Directed Acyclic Graph (DAG) for deterministic convergence.
- **Rich Collaborative Types**: Built-in support for `YMap`, `YArray`, and `YText` (with formatting/formatting events).
- **Non-Destructive History**: Undo and Redo management using the `UndoManager` and travel-in-time capabilities using state snapshots and version histories.
- **Ephemeral State Tracking**: Native support for presence and ephemeral client state tracking (awareness) such as cursors.
- **Strictly Typed & Convergence-Tested**: Built with strict TypeScript and convergence guarantees validated under heavy unit testing.

---

## Core Concepts

The core library is centered around these primary components:

- **`Doc`**: The root document container. Serves as the entry point to instantiate collaborative shared types and access the internal walking engine.
- **`EgWalker`**: The Event Graph walker engine. Processes incoming remote events, registers local actions, and maintains metadata like replica sequence numbers and awareness.
- **`EventGraph`**: A directed acyclic graph (DAG) representing all applied operations. It is the logical source of truth, facilitating version tracking, delta computations, and deterministic sorting of concurrent edits.

---

## Getting Started

### Installation

```bash
pnpm add @ddgll/ts-crdt
```

### Basic Usage

```typescript
import { Doc } from "@ddgll/ts-crdt";

// 1. Create a document instance for a specific replica/client
const doc = new Doc("replica-A");

// 2. Access the root YMap
const rootMap = doc.getMap();

// 3. Perform local operations
rootMap.set("username", "alice");

// 4. Retrieve values
console.log(rootMap.get("username")); // Output: 'alice'

// 5. Query changes to sync with other clients
const version = doc.egWalker.getVersion();
const changes = doc.egWalker.graph.getChangesSince([]); // get all events
```

---

## Shared Collaborative Data Types

### `YMap`
A shared key-value map supporting nested maps, arrays, or text.

```typescript
const map = doc.getMap();
map.set("title", "Project Docs");

// Nesting another Map
const settings = map.getMap("settings");
settings.set("theme", "dark");
```

### `YArray`
A collaborative ordered list of values or nested collaborative types.

```typescript
const list = doc.getMap().getArray("todoList");
list.insert(0, ["Buy milk", "Walk the dog"]);
list.delete(1, 1); // Removes 'Walk the dog'
list.replace(["Read a book"]); // Replaces all elements
```

### `YText`
A collaborative text container for building rich text editors, supporting index-based insertions, deletions, and formatting attributes.

```typescript
const text = doc.getMap().getText("editorText");
text.insert(0, "Hello World");
text.format(0, 5, { bold: true }); // formats "Hello" with bold: true
```

---

## Advanced Features

### Undo/Redo (Non-Destructive History)

`UndoManager` tracks document versions in the event graph to perform non-destructive history traversal.

```typescript
import { UndoManager } from "@ddgll/ts-crdt";

const undoManager = new UndoManager(doc.egWalker);

map.set("counter", 1);
undoManager.track(); // Snapshot version 1

map.set("counter", 2);
undoManager.track(); // Snapshot version 2

undoManager.undo();
console.log(map.get("counter")); // 1

undoManager.redo();
console.log(map.get("counter")); // 2
```

### Presence & Ephemeral Awareness

Share ephemeral data (like cursor locations or active selections) across clients without writing it to the persistent event graph.

```typescript
// Broadcast local cursor
doc.egWalker.setAwareness({ cursor: { line: 5, ch: 12 } });

// Read another user's status
const partnerState = doc.egWalker.getAwareness("replica-B");
```

### Time-Travel History Rebuilds

Revert the document state to any previous topological version in the DAG without destroying intermediate events.

```typescript
// Record a version
const oldVersion = doc.egWalker.getVersion();

// Make some edits
map.set("x", 100);

// Travel back in time (restores state in-memory)
doc.egWalker.rebuildStateAtVersion(oldVersion);
console.log(map.get("x")); // undefined
```

---

## Monorepo Integrations

For network synchronization and persistence, utilize the specialized workspace packages:
- **Client Synchronization**: Refer to [`@ddgll/ts-crdt-client`](../client/README.md) for WebSocket client-binding and editor text syncing.
- **Server Replication & DB Storage**: Refer to [`@ddgll/ts-crdt-server`](../server/README.md) for running collaborative WebSocket backends and database persistence adapters.
