# ts-crdt

A monorepo containing a TypeScript-based CRDT (Conflict-free Replicated Data Type) library and a demonstration application.

## Packages

- **[packages/core](./packages/core)**: The core library implementing an event-driven CRDT engine with support for `YMap`, `YArray`, and `YText`, featuring history management and awareness.
- **[packages/demo](./packages/demo)**: A real-time collaborative rich-text editor showcasing the core library, built with Tiptap, Hono, WebSockets, and SQLite.

## Development

### Prerequisites

- Node.js
- pnpm

### Getting Started

1.  **Install dependencies**:
    ```bash
    pnpm install
    ```

2.  **Build the project**:
    ```bash
    pnpm build
    ```

3.  **Run tests**:
    ```bash
    pnpm test
    ```
