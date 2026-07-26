# Agent and Developer Guide (`agents.md`)

This guide serves as the source of truth for both developers and AI agents
developing, testing, and maintaining the `@ddgll/ts-crdt` codebase. It outlines
the project structure, development workflows, testing patterns, and coding
standards.

---

## Project Overview

This is a TypeScript monorepo managed with **pnpm workspaces**. It is split into
two packages:

- **`packages/core`**: The core event-driven CRDT library. It contains the data
  structures (`YMap`, `YArray`, `YText`), the DAG-based `EventGraph`, and the
  engine `EgWalker` which applies and propagates events.
- **`packages/demo`**: A collaborative text editor demo demonstrating rich-text
  collaboration over WebSockets, with persistence using SQLite (LibSQL + Drizzle
  ORM).

---

## 1. Development Workflow ("How to Dev")

To develop on this codebase, you need to compile changes in the core package and
run the demo application to verify behavior.

### Setting Up Dependencies

Install dependencies at the root of the monorepo:

```bash
pnpm install
```

### Concurrent Local Development

Local development relies on compiling core in watch mode and running the demo
server concurrently:

1. **Terminal 1: Core Compiler (Watch Mode)** Run the TypeScript compiler in
   watch mode in the core package. This automatically compiles `.ts` files to
   `dist/` on change:
   ```bash
   pnpm --filter @ddgll/ts-crdt dev
   ```

2. **Terminal 2: Demo Web Server & Frontend** Run the Hono development server.
   This bundles frontend files using `esbuild` and starts the Hono app:
   ```bash
   pnpm --filter @ddgll/ts-crdt-demo dev
   ```

3. **Verify the App** Open your browser and navigate to:
   - **Simple Textarea Demo**: [http://localhost:3000](http://localhost:3000)
   - **Rich Text Editor Demo**:
     [http://localhost:3000/rich.html](http://localhost:3000/rich.html)

### Database Migrations

- **SQLite Database File**: The database file `sqlite.db` is stored in the demo
  package (`packages/demo/sqlite.db`), resolved relative to the demo server's
  working directory at runtime.
- **Automatic Migration**: Migrations are applied programmatically on startup by
  Hono in `packages/demo/server/server.ts` utilizing Drizzle's `migrate` helper.
  You do not need to manually run CLI commands to apply migrations when
  developing.

---

## 2. Unit and Integration Testing ("How to Create Tests")

Unit and integration tests target the CRDT engine and its data structures. They
are powered by **Vitest**.

### Running Tests

You can run tests from the root of the monorepo:

```bash
pnpm test
```

This command runs each workspace package's own `test` script
(`pnpm -r run test`); the core package runs `vitest --run`.

### Writing New Tests

All core unit tests are located inside `packages/core/src/[component]/tests/`
(e.g. `packages/core/src/crdtTypes/tests/`).

#### Testing Guidelines:

1. **Naming Conventions**: Test files must end with `.test.ts` (e.g.,
   `MyCrdtType.test.ts`).
2. **Framework Functions**: Import `describe`, `it`, and `expect` explicitly
   from Vitest — globals are **disabled** (`globals: false` in
   `vitest.config.ts`).
3. **Independent Replicas**: When testing CRDT merges, instantiate multiple
   independent `Doc` instances (e.g., `const doc1 = new Doc("replica-1")`) and
   simulate network syncing using `doc.egWalker.integrateRemote()`.

#### Test Template Example:

```typescript
import { describe, expect, it } from "vitest";
import { Doc } from "../doc.js";

describe("My Custom CRDT Feature", () => {
   it("should merge changes deterministically between replicas", () => {
      // 1. Initialize two documents
      const docA = new Doc("replica-A");
      const docB = new Doc("replica-B");

      // 2. Perform local operations on Doc A
      const mapA = docA.getMap();
      const eventA = mapA.set("greeting", "Hello");

      // 3. Sync event A to Doc B
      docB.egWalker.integrateRemote([eventA]);

      // 4. Assert convergence
      expect(docB.getMap().get("greeting")).toBe("Hello");
   });
});
```

---

## 3. End-to-End Testing ("How to Create E2E Tests")

End-to-End tests verify collaborative synchronization across multiple concurrent
browser instances using **Playwright**.

### Running E2E Tests

Run E2E tests from the root using:

```bash
pnpm e2e
```

_Note: This command builds the core package first, starts the Hono server
automatically using global setup, runs the Playwright tests, and tears down the
server afterward._

### E2E Test Infrastructure

- **Server Lifecycle**: Managed by `packages/demo/e2e/global-setup.ts` and
  `global-teardown.ts`. They delete the existing `sqlite.db` database for a
  clean state, spawn the server process (`pnpm dev`), and kill the process group
  on finish.
- **WebSocket Synchronization**: Test scenarios simulate multiple users by
  opening separate Playwright browser contexts.

### Writing E2E Tests

E2E tests are located in `packages/demo/e2e/` (e.g., `e2e.spec.ts`,
`multi-user.spec.ts`).

#### E2E Best Practices:

1. **Clean DB State**: Every test block should reset the server database to
   ensure a clean state using Playwright's page request API:
   ```typescript
   test.beforeEach(async ({ page }) => {
      await page.request.get("http://localhost:3000/reset");
   });
   ```
2. **Multiple Contexts**: Use separate browser contexts rather than sharing
   pages to isolate user sessions:
   ```typescript
   const context1 = await browser.newContext();
   const page1 = await context1.newPage();
   ```
3. **Simulating Offline State**: Use Playwright's `setOffline` API to simulate
   network disconnects and verify offline CRDT synchronization logic:
   ```typescript
   // Disconnect client 2
   await context2.setOffline(true);
   // Make edits...
   // Reconnect client 2
   await context2.setOffline(false);
   ```

---

## 4. Coding Standards ("How to Create Standards")

All code contributed to this repository must align with the following standards:

### TypeScript & Module System

1. **ESM Imports**: The repository compiles as ECMAScript Modules
   (`"type": "module"`). All relative imports **must explicitly include the
   `.js` extension** (e.g., `import { YMap } from "./yMap.js";` even when
   importing from `YMap.ts`).
2. **Strict Typings**: `"strict": true` is enabled in `tsconfig.json`. Explicit
   `any` should be avoided. Use type guards (like `isCrdtEvent(event)`) when
   parsing external inputs.
3. **Source Maps**: Compile outputs include source maps (`.js.map`) for accurate
   stack traces.

### CRDT Architecture & Event-Driven Engine

1. **Operation Immutability**: All CRDT mutations must create an immutable `Op`
   object matching the union type in
   `packages/core/src/eventGraph/eventGraph.ts`.
2. **State Mutability**: The document state must **never** be directly mutated.
   Any local change must:
   - Call `doc.egWalker.localOp(op)` which creates a `CrdtEvent`.
   - Append the event to the local `EventGraph` using `addEvent`.
   - Propagate changes to the internal document model using internal apply
     functions (e.g. `_applySet`, `_applyInsert`).
3. **Deterministic Event Sorting**: Concurrent events must be sorted
   topologically and deterministically. The sorting mechanism (e.g.,
   `topologicalSort`) orders concurrent events by comparing their unique
   `EventID` strings to ensure all replicas converge on the exact same state.
4. **ID Scheme**: Event IDs must be globally unique strings formatted as
   `<replicaId>:<sequenceNumber>`.

### Linting & Formatting

- **ESLint**: Standard rules are enforced through the Flat Config system
  (`eslint.config.js`).
- Run the linter using:
  ```bash
  pnpm lint
  ```
- **Unused Variables**: Unused variables are treated as errors. If an unused
  variable is necessary (e.g., matching a function signature), prefix it with an
  underscore (e.g., `_evt`).
