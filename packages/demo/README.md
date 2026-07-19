# ts-crdt Demo App (`@ddgll/ts-crdt-demo`)

A real-time collaborative text and rich-text editing workspace that demonstrates the capabilities of the core `ts-crdt` engine alongside the `@ddgll/ts-crdt/client` and `@ddgll/ts-crdt/server` wrappers.

## Core Stack

- **Frontend**: 
  - [Tiptap](https://tiptap.dev/) (headless rich-text editor framework).
  - WebSockets (native browser connection wrapped by `@ddgll/ts-crdt/client`).
- **Backend**: 
  - [Hono](https://hono.dev/) (ultrafast Node web server framework).
  - Node WebSocket middleware (`@hono/node-ws`) integrated with `@ddgll/ts-crdt/server`.
- **Database & ORM**: 
  - [Drizzle ORM](https://orm.drizzle.team/) for migrations and queries.
  - **SQLite** for persisting CRDT event history (`packages/demo/sqlite.db`, resolved relative to the demo server's working directory).

---

## Features Showcase

1. **Collaborative Textarea Demo** (`index.html`): Synchronizes simple character insertions and deletions inside a default `<textarea>`.
2. **Collaborative Rich-Text Demo** (`rich.html`): Synchronizes bold, italics, headers, lists, and structural formats inside a Tiptap editor.
3. **Text-DB Demo** (`text-db.html`, served over the `/ws-text` endpoint): A textarea variant backed by an in-memory text repository, used to exercise the alternate persistence path.
4. **Multi-Room Collaboration**: Isolates editors based on the `?room=` URL query parameter. The server handles room mappings dynamically.
5. **Persistent Sync**: Server-side Hono WebSocket processes retrieve past events from SQLite on start to reconstruct exact document histories.
6. **Robust E2E Suite**: Pre-configured Playwright tests simulating multiple isolated clients and network connectivity loss.

---

## Running the Demo

### 1. Install Dependencies
Run the install command from the root of the monorepo:
```bash
pnpm install
```

### 2. Start Dev Servers
Start the dev servers (which compiles the core/client/server packages and serves the frontend/backend bundles):
```bash
pnpm --filter @ddgll/ts-crdt-demo dev
```

### 3. Open in Browser
- **Simple Textarea Demo**: [http://localhost:3000](http://localhost:3000)
- **Rich Text Editor Demo**: [http://localhost:3000/rich.html](http://localhost:3000/rich.html)

To simulate collaboration, open the links in multiple browser windows or separate tabs with the same room parameter (e.g. `http://localhost:3000/rich.html?room=room-1`).

---

## Architecture & Code Structure

- **`server/server.ts`**: Initialises migrations, sets up Hono routes, sets up dynamic sqlite room repositories, and forwards WebSocket upgrades to the `@ddgll/ts-crdt/server` wrapper.
- **`interactive-test/rich.ts`**: Connects Tiptap editor events to the `@ddgll/ts-crdt/client` instance. Utilizes `syncText` to apply character changes and manages loop detection using the `isApplyingRemoteChanges` blocker.
- **`interactive-test/main.ts`**: The plain textarea integration demonstrating minimal CRDT synchronization.
- **`drizzle/`**: Schema definition and SQLite migrations.
- **`e2e/`**: Playwright test suite to simulate concurrency, multi-user sync, database resets, and client offline synchronization.

For a detailed technical walkthrough of client-server orchestration, see [INTEGRATION.md](./INTEGRATION.md).
