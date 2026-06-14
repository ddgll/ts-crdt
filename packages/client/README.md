# @ddgll/ts-crdt-client

Client-side synchronization wrapper for the `ts-crdt` collaborative editor. It binds a local CRDT document to a WebSocket connection and provides utilities for syncing text changes dynamically from textareas or rich text editors.

## Features

- **Automatic Sync**: Propagates local operations to the server and integrates incoming remote events automatically.
- **Echo Prevention**: Ignores echo events from the server (events initiated by the local replica).
- **Text Sync Helper**: Features `syncText()`, which performs diffing between new text input and the current CRDT state (either `YArray` or `YText`) and applies minimal character-level operations.
- **Custom Callbacks**: Exposes `onMessage` to listen to raw sync messages (such as server snapshots).

---

## Installation

Install in your client application:

```bash
pnpm add @ddgll/ts-crdt-client
```

---

## Getting Started

### 1. Initialize and Bind `CrdtClient`

```typescript
import { Doc } from "@ddgll/ts-crdt";
import { CrdtClient } from "@ddgll/ts-crdt-client";

// Create local Doc
const doc = new Doc();

// Initialize CrdtClient wrapping the Doc
const client = new CrdtClient(doc);

// Establish browser WebSocket connection
const ws = new WebSocket("ws://localhost:3000/ws?room=my-room");

// Bind client to the socket
client.bind(ws);
```

### 2. Synchronize Text Input Dynamically

The `syncText()` helper is useful when integrating with standard HTML inputs (like a `<textarea>`) or framework-based text editors. Instead of replacing the entire text value on every keypress, it calculates the minimum set of character modifications (insertions and deletions) to ensure efficient merge and synchronization.

```typescript
const textarea = document.querySelector("#my-textarea") as HTMLTextAreaElement;

// Sync input changes to a YArray of characters at root key "content"
textarea.addEventListener("input", () => {
  client.syncText(["content"], textarea.value, "array");
});

// Update the textarea when changes are received from remote users
client.onMessage((type, data) => {
  if (type === "event" || type === "snapshot") {
    // If not currently typing/applying local changes
    if (!client.isApplyingRemoteChanges()) {
      const array = doc.getMap().getArray("content");
      textarea.value = array.toJSON().join("");
    }
  }
});
```

---

## API Reference

### `CrdtClient`

#### `constructor(doc: Doc)`
Instantiates a new client for the given `Doc` instance.

#### `bind(socket: MinimalClientWebSocket): void`
Binds the client to a WebSocket. The socket must satisfy the `MinimalClientWebSocket` interface (which includes browser `WebSocket` and `ws` in Node). Sets up listeners for incoming messages and document changes. Throws an error if already bound.

#### `unbind(): void`
Closes the document change listener subscription and unbinds from the current socket.

#### `onMessage(cb: (type: "snapshot" | "event", data: unknown) => void): () => void`
Registers a callback to listen to raw WebSocket events. Returns an unsubscribe function.

#### `isApplyingRemoteChanges(): boolean`
Returns whether the client is currently integrating remote edits. This is crucial for UI input handling to avoid infinite update loops.

#### `getDoc(): Doc`
Returns the underlying wrapped `Doc` instance.

#### `syncText(path: (string | number)[], newText: string, type?: "array" | "text"): void`
Performs an in-memory diff between the new text string and the existing container (resolved at `path`).
- `path`: Key path to the target container (e.g. `["content"]`).
- `newText`: The updated full string value.
- `type`: Target container type. Can be `"array"` (to sync characters to a `YArray`) or `"text"` (to sync characters to a `YText`). Defaults to `"array"`.
