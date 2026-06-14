# ts-crdt Monorepo

A lightweight, robust, and highly extensible monorepo containing an event-driven TypeScript CRDT (Conflict-free Replicated Data Type) library, client/server WebSocket sync wrappers, and a real-time collaborative text editor demo.

## Monorepo Architecture

This project is organized as a **pnpm workspace** divided into the following packages:

| Package | Name | Description |
| :--- | :--- | :--- |
| [**`packages/core`**](./packages/core) | `@ddgll/ts-crdt` | The core CRDT engine implementing the DAG-based `EventGraph`, `EgWalker`, state snapshotting, undo/redo history, awareness/presence, and CRDT types (`YMap`, `YArray`, `YText`). |
| [**`packages/client`**](./packages/client) | `@ddgll/ts-crdt-client` | Client-side WebSocket integration that binds a local `Doc` to a collaborative websocket connection and includes a text-diffing sync helper (`syncText`). |
| [**`packages/server`**](./packages/server) | `@ddgll/ts-crdt-server` | Reusable server-side collaborative sync agent. Manages in-memory document state, broadcasts events to connected clients, and abstracts database persistence via the `Repository` pattern. |
| [**`packages/demo`**](./packages/demo) | `@ddgll/ts-crdt-demo` | A full-stack real-time collaborative rich-text and plain-text editor demo built using Tiptap, WebSockets, Hono, and SQLite (Drizzle ORM). |

---

## Development Guide

### Prerequisites

- **Node.js** (v18+ or v20+)
- **pnpm** (workspace package manager)

### Getting Started

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Build the packages**:
   ```bash
   pnpm build
   ```

3. **Run tests**:
   ```bash
   pnpm test
   ```

4. **Run End-to-End (E2E) tests**:
   ```bash
   pnpm e2e
   ```

5. **Lint and Type-Check**:
   ```bash
   pnpm lint
   pnpm type-check
   ```

---

## Concurrent Local Development (Demo App)

To run the demo app locally and develop interactively:

1. **Start Core package compiler in Watch Mode**:
   ```bash
   pnpm --filter @ddgll/ts-crdt dev
   ```

2. **Start the Demo Web Server**:
   ```bash
   pnpm --filter @ddgll/ts-crdt-demo dev
   ```

3. **Verify the App**:
   Open [http://localhost:3000](http://localhost:3000) for the simple textarea demo or [http://localhost:3000/rich.html](http://localhost:3000/rich.html) for the rich text editor.

For detailed guidelines on development, testing standards, and best practices, check [agents.md](./agents.md).
