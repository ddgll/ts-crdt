# Interactive Test Implementation

This document provides a detailed explanation of the interactive rich-text editor, covering both the server and client-side implementations.

## Server-Side Implementation (`server/server.ts`)

The server is the central authority in the collaborative editing environment, responsible for receiving, persisting, and broadcasting changes to all connected clients. It is built with Hono, a lightweight and fast web framework for Node.js, and uses WebSockets for real-time communication.

### Core Technologies

-   **Hono**: A modern web framework for building APIs and web applications.
-   **Drizzle ORM**: A TypeScript ORM used for interacting with the SQLite database.
-   **@hono/node-ws**: A middleware that enables WebSocket support in Hono applications running on Node.js.
-   **SQLite**: A self-contained, serverless SQL database engine used for persisting CRDT events.

### Server Initialization

The `initializeServer` function is the entry point for the server. It performs the following steps:

1.  **Database Migration**: It runs database migrations using Drizzle to ensure the database schema is up-to-date.
2.  **State Loading**: It loads all existing CRDT events from the `events` table in the database and integrates them into a central `Doc` instance. This allows the server to reconstruct the document's current state upon startup. If no events are found, it initializes a new document.

### WebSocket Communication

The server uses WebSockets to maintain a persistent connection with each client.

-   **`onOpen`**: When a client connects, the server assigns it a unique ID, adds it to a `sockets` map, and sends the complete document state as a "snapshot." This ensures the new client is immediately synchronized with the current content.
-   **`onMessage`**: When a client sends a CRDT event, the server:
    1.  Persists the event to the SQLite database.
    2.  Integrates the event into its own `Doc` instance.
    3.  Broadcasts the event to all connected clients, ensuring everyone receives the update.
-   **`onClose` / `onError`**: When a client disconnects or an error occurs, the server removes the client from the `sockets` map to prevent attempts to send messages to a closed connection.

### API Endpoints

-   **`/ws`**: The WebSocket endpoint where clients connect for real-time communication.
-   **`/reset`**: A utility endpoint that clears the database and resets the in-memory document state. This is primarily used for testing to ensure a clean state between test runs.

### Static File Serving

The server is also responsible for serving the static files for the client-side application, including the HTML, CSS, and the bundled JavaScript for the interactive test.

## Client-Side Implementation (`interactive-test/rich.ts`)

The client-side script manages the user interface, handles user input, and communicates with the server to synchronize the document state.

### Core Technologies

-   **Tiptap**: A headless, framework-agnostic editor toolkit that provides a rich set of extensions for building custom text editors.
-   **WebSocket**: The native browser API for real-time, bidirectional communication with the server.

### Editor Setup

The client initializes a Tiptap `Editor` instance and configures it with the `StarterKit` extension, which provides a baseline of common text editing features (e.g., bold, italics, headings, lists). The editor is initially set to be non-editable until a connection with the server is established and the initial state is loaded.

### WebSocket Communication

The client establishes a WebSocket connection to the server's `/ws` endpoint.

-   **`onopen`**: Logs a message to the console indicating a successful connection.
-   **`onmessage`**: Handles incoming messages from the server.
    -   **`snapshot`**: When a snapshot is received, the client loads the entire document state into its local `Doc` instance. It then updates the editor's content, marks the editor as editable, and sets the `isInitialized` flag to `true`.
    -   **`event`**: When a remote CRDT event is received, the client first checks that the event is not an echo of its own change (by comparing `replicaId`). If it's a valid remote event, it integrates the event into its local `Doc` and updates the editor's content.
-   **`onclose` / `onerror`**: If the connection is lost, the editor is set back to non-editable to prevent further changes.

### State Synchronization

A critical aspect of the client is managing the flow of changes to prevent infinite loops, where a remote update triggers a local update, which is then sent back to the server.

-   **`isApplyingRemoteChanges` flag**: This flag is set to `true` just before the client's content is updated with remote changes. The `editor.on("update", ...)` handler checks this flag and ignores any changes that occur while it is `true`. A `setTimeout` is used to reset the flag asynchronously, ensuring that the DOM has fully updated before re-enabling local change detection.

### Local Change Detection

When the user modifies the content in the editor, the `editor.on("update", ...)` event is triggered. The client then performs a diffing algorithm on the editor's HTML content to determine what has changed:

1.  It compares the `newHtml` with the `previousHtml` to find the start and end of the changed region.
2.  Based on the diff, it identifies deleted and inserted content.
3.  It generates the corresponding `localDelete` and `localInsert` CRDT events.
4.  These events are sent to the server via the WebSocket connection.
5.  Finally, it.
This diffing approach ensures that only the minimal necessary changes are sent over the network, making the collaborative experience efficient.