# @ddgll/ts-crdt-server

Server-side coordination and persistence wrapper for the `ts-crdt` collaborative framework. It provides WebSocket connection handlers to broadcast CRDT events and sync document snapshots, backed by a custom database storage abstraction (the `Repository` pattern).

## Features

- **Replication Engine**: Automatically orchestrates connection lifecycles, sending full snapshots on join and broadcasting client changes in real-time.
- **Pluggable Persistence**: Decouples storage from logic using the `Repository` interface. Plug in SQLite, PostgreSQL, Redis, or simple in-memory storage.
- **Multi-room Orchestration**: Features the `handleWebSocket` helper which automatically maps and caches server instances per room/repository.
- **Framework Agnostic**: Integrates seamlessly with `ws`, Hono (Node WebSocket), Express, Koa, or raw Node HTTP servers.

---

## Installation

Install in your server application:

```bash
pnpm add @ddgll/ts-crdt-server
```

---

## Getting Started

### 1. Implement a Repository

To persist CRDT events, implement the `Repository` interface:

```typescript
import { Repository } from "@ddgll/ts-crdt-server";
import { CrdtEvent } from "@ddgll/ts-crdt";

class MySQLiteRepository implements Repository {
  async getEvents(): Promise<CrdtEvent[]> {
    // Fetch and return all persisted events sorted by creation/sequence order
    return db.select().from(eventsTable);
  }

  async saveEvent(event: CrdtEvent): Promise<void> {
    // Save a new incoming CRDT event
    await db.insert(eventsTable).values(event);
  }

  async clearEvents(): Promise<void> {
    // (Optional) Clear all events, e.g. for testing resets
    await db.delete(eventsTable);
  }
}
```

### 2. Handle WebSockets in a Server (e.g. Hono)

```typescript
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { handleWebSocket, resetServer } from "@ddgll/ts-crdt-server";

const app = new Hono();
const { upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    // Support multiple rooms dynamically
    const roomId = c.req.query("room") || "default";
    const repository = getRoomRepository(roomId); // returns Repository instance

    return {
      onOpen: (_event, webSocket) => {
        // Feed the raw WebSocket connection and repository to handleWebSocket helper
        handleWebSocket(webSocket.raw, repository).catch(console.error);
      },
    };
  })
);
```

---

## API Reference

### `Repository` Interface

Your database schema or in-memory array must implement this interface to integrate persistence:

- `getEvents(): Promise<CrdtEvent[]>`: Retreives all events.
- `saveEvent(event: CrdtEvent): Promise<void>`: Stores an event.
- `clearEvents?(): Promise<void>`: (Optional) Wipes all events for the doc.

---

### Class: `CrdtServer`

#### `constructor(repository: Repository)`
Instantiates a server state manager for a given repository.

#### `initialize(): Promise<void>`
Loads all existing events from the repository and builds the initial document state in memory. If the repository is empty, it initializes the document with an initial structure.

#### `handleConnection(socket: MinimalWebSocket): Promise<void>`
Registers a socket connection, sends it the current document snapshot, and configures event listeners to store and broadcast client operations.

#### `reset(): Promise<void>`
Wipes the server's in-memory state, deletes events from the database repository, and re-initializes the document.

---

### Utility Functions

#### `handleWebSocket(socket: MinimalWebSocket, repository: Repository): Promise<void>`
A high-level wrapper that manages server instances automatically. It tracks instances in a global cache using the repository instance as a key. If no `CrdtServer` exists for the repository, it instantiates one, initializes it, and binds the WebSocket.

#### `resetServer(repository: Repository): Promise<void>`
Retrieves the active `CrdtServer` instance for the given repository and triggers its `reset()` method.
