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
4. **Collaborative JSON Document Demo** (`json.html`): Edits an arbitrary JSON document — nested objects, arrays of records, strings, numbers — mapped onto nested `YMap`/`YArray`/`YText`. Every field merges independently, so two clients editing different fields of the same record (or different records of the same array) both keep their edits. See [JSON documents](#json-documents) below.
5. **Multi-Room Collaboration**: Isolates editors based on the `?room=` URL query parameter. The server handles room mappings dynamically.
6. **Persistent Sync**: Server-side Hono WebSocket processes retrieve past events from SQLite on start to reconstruct exact document histories.
7. **Robust E2E Suite**: Pre-configured Playwright tests simulating multiple isolated clients and network connectivity loss.

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
- **JSON Document Demo**: [http://localhost:3000/json.html](http://localhost:3000/json.html)

To simulate collaboration, open the links in multiple browser windows or separate tabs with the same room parameter (e.g. `http://localhost:3000/rich.html?room=room-1`).

---

## Architecture & Code Structure

- **`server/server.ts`**: Initialises migrations, sets up Hono routes, sets up dynamic sqlite room repositories, and forwards WebSocket upgrades to the `@ddgll/ts-crdt/server` wrapper.
- **`interactive-test/rich.ts`**: Connects Tiptap editor events to the `@ddgll/ts-crdt/client` instance. Utilizes `syncText` to apply character changes and manages loop detection using the `isApplyingRemoteChanges` blocker.
- **`interactive-test/main.ts`**: The plain textarea integration demonstrating minimal CRDT synchronization.
- **`interactive-test/jsonCrdt.ts`**: Maps arbitrary JSON onto nested CRDT containers and reconciles a plain-JSON value into the minimal set of operations. Framework-free and unit-tested in `interactive-test/tests/`.
- **`interactive-test/json.ts`**: The JSON document demo UI built on `jsonCrdt.ts`.
- **`drizzle/`**: Schema definition and SQLite migrations.
- **`e2e/`**: Playwright test suite to simulate concurrency, multi-user sync, database resets, and client offline synchronization.

For a detailed technical walkthrough of client-server orchestration, see [INTEGRATION.md](./INTEGRATION.md).

---

## JSON documents

`ts-crdt` has no dedicated JSON type, but arbitrary JSON maps cleanly onto its
containers. `interactive-test/jsonCrdt.ts` implements that mapping and is
independent of the demo UI — copy it into your own app if you need it.

| JSON                    | CRDT representation          | Merge granularity         |
| ----------------------- | ---------------------------- | ------------------------- |
| object                  | `YMap`                       | per key                   |
| string                  | `YText`                      | per character             |
| number / boolean / null | primitive in a `YMap` slot   | last-writer-wins per key  |
| array of primitives     | `YArray`                     | per element (RGA)         |
| array of objects        | keyed collection (see below) | per field of each element |

### Why arrays of objects need a keyed collection

Two properties of the engine make the obvious encoding — a `YArray` whose
elements are nested `YMap`s — quietly wrong:

1. **Nested containers do not survive the wire.** A `YArray` element can hold a
   `YMap` in memory, but events are JSON-serialized before being sent, and a
   nested container collapses into a plain object in the payload. The receiving
   replica stores an inert object, so later edits addressed into it never land.
2. **Array paths are positional.** Operations address array elements by index
   (`["items", 2, "title"]`), so a concurrent insert earlier in the array
   silently re-targets an in-flight edit at a different element. Replicas still
   converge — they just converge on the wrong element having been edited.

Both go away when elements are addressed by a stable key, so an array of objects
is stored as a `YMap` holding `#order` (a `YArray` of element ids, which is what
merges reordering and insertion) and `#items` (a `YMap` of id → element).
Element identity comes from the object's own `id`/`_id`/`uuid` field when
present, and falls back to position otherwise. `#`-prefixed keys are reserved by
the encoding and never appear in the JSON view.

### Other things worth knowing

- **Empty containers need materializing.** `getMap`/`getArray`/`getText` create
  a container without emitting an event, so an `{}` or `[]` that nothing is ever
  written into stays local and never reaches a peer. The encoder emits a
  `#empty` marker for empty objects and an empty `insert` for empty arrays.
- **Key order is not stable across replicas.** Replicas converge on content, but
  a client that authored an object holds its keys in authoring order while one
  that replayed it from events holds them in event order. Compare documents with
  a deep, order-insensitive equality — never by hashing `JSON.stringify` output.
- **Bulk changes are transport-bound.** Seeding 200 records emits ~1400
  operations. Integrating them costs ~20 ms, but they cross the WebSocket as
  ~1400 individual messages, which takes several seconds. A late-joining client
  loads the same document from a server snapshot in milliseconds.

### Tests

- `interactive-test/tests/jsonCrdt.test.ts` — unit tests for the encoding,
  including replication through a simulated wire round-trip (`pnpm test`).
- `e2e/json-editing.spec.ts` — Playwright tests driving real browsers against
  the real server: 200-record documents, concurrent edits across 50 records,
  character-level merges, concurrent append/delete, and offline reconnection
  (`pnpm e2e`).
