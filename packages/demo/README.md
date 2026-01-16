# ts-crdt Demo

A real-time collaborative rich-text editor demonstrating the capabilities of the `ts-crdt` core library.

## Stack

- **Frontend**: Tiptap (Rich Text Editor)
- **Backend**: Hono (Server), WebSockets (Real-time communication)
- **Persistence**: SQLite

## Getting Started

1.  **Install dependencies** (from the root):
    ```bash
    pnpm install
    ```

2.  **Run the demo**:
    ```bash
    pnpm dev
    ```

   This will start the development server, usually accessible at `http://localhost:5173` (or the port specified in the output).

## Documentation

For a detailed explanation of the integration and architecture, please refer to [INTEGRATION.md](./INTEGRATION.md).
