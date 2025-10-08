# @ddgll/ts-crdt

A modern, event-driven CRDT (Conflict-free Replicated Data Type) library for
building real-time collaborative applications in TypeScript.

## Introduction

The @ddgll/ts-crdt library is a powerful toolkit for building real-time
collaborative applications. It provides a set of data structures that can be
independently updated and then merged without conflicts, making it ideal for
distributed systems. The library is built around a generalized, event-driven
architecture, ensuring that changes are propagated efficiently and consistently
across all replicas.

## Core Concepts

The library is built around a few key components:

- **`Doc`**: The main container for a CRDT document. It holds the shared data
  types and the event graph.
- **`EgWalker` (EventGraph Walker)**: The engine that processes and applies
  changes to the document. It manages the event graph, replica IDs, and
  awareness state.
- **Event Graph**: A directed acyclic graph (DAG) of all operations that have
  occurred in the document. This graph is the source of truth and allows for
  powerful features like history traversal and synchronization.

## Getting Started

First, install the library:

```bash
pnpm add @ddgll/ts-crdt
```

Then, you can start using it in your project:

```typescript
import { Doc } from "@ddgll/ts-crdt";

// Create a new document with a unique ID for this client
const doc = new Doc("replica-1");

// Get the root map
const rootMap = doc.getMap();

// Set a value
rootMap.set("key", "value");

// Get the value
console.log(rootMap.get("key")); // Outputs: 'value'

// The library automatically tracks changes in an event graph.
// You can get the changes since a certain version to send to other clients.
const changes = doc.egWalker.graph.getChangesSince([]);
console.log(changes);
```

## Data Types

The library provides several shared data types that you can use to build your
collaborative data model.

### `YMap`

A shared map, similar to a JavaScript `Map`.

```typescript
const map = doc.getMap();

// Set key-value pairs
map.set("name", "John Doe");
map.set("age", 30);

// Create a nested map
const address = map.getMap("address");
address.set("street", "123 Main St");
```

### `YArray`

A shared array, similar to a JavaScript `Array`.

```typescript
const array = doc.getMap().getArray("myArray");

// Insert elements
array.insert(0, ["a", "b", "c"]); // -> ['a', 'b', 'c']

// Delete elements
array.delete(1, 1); // -> ['a', 'c']

// Replace the entire array
array.replace(["x", "y", "z"]); // -> ['x', 'y', 'z']
```

### `YText`

A shared text type for collaborative rich-text editing.

```typescript
const text = doc.getMap().getText("myText");

// Insert text
text.insert(0, "Hello World");
console.log(text.toString()); // "Hello World"

// Apply bold formatting to "Hello"
text.format(0, 5, { bold: true });
```

## Advanced Features

### Undo/Redo

The `UndoManager` provides a simple way to add undo/redo functionality to your
application.

```typescript
import { UndoManager } from "@ddgll/ts-crdt";

const undoManager = new UndoManager(doc.egWalker);

map.set("key", "value1");
undoManager.track();

map.set("key", "value2");
undoManager.track();

undoManager.undo();
console.log(map.get("key")); // 'value1'

undoManager.redo();
console.log(map.get("key")); // 'value2'
```

### Awareness / Presence

Awareness allows clients to share ephemeral state, such as cursor positions or
online status, without saving it to the document's event graph.

```typescript
// Set the local awareness state
doc.egWalker.setAwareness({ user: "Alice", cursor: { x: 10, y: 20 } });

// Get the awareness state of a specific client
const alicesState = doc.egWalker.getAwareness("replica-1");
```

### History Traversal

You can revert the document to any previous version in its history without
modifying the event graph itself. This is useful for viewing historical
snapshots.

```typescript
// Get the current version
const currentVersion = doc.egWalker.getVersion();

// Make some changes...
map.set("anotherKey", "anotherValue");

// Revert the document state to the previous version
doc.egWalker.rebuildStateAtVersion(currentVersion);
```

## Contributing

We welcome contributions! To get started, set up the monorepo environment:

1. **Install Dependencies**:
   ```bash
   pnpm i
   ```

2. **Run Tests**:
   ```bash
   pnpm test
   ```

3. **Lint and Type-Check**:
   ```bash
   pnpm lint
   pnpm type-check
   ```

## Demo Application

The `packages/demo` directory contains a rich-text editor built with Tiptap that
demonstrates a real-world use case of the library, including real-time
collaboration over WebSockets. See the `INTEGRATION.md` file within that package
for more details on its implementation.
