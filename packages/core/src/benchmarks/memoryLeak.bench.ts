import { bench, describe } from 'vitest';
import { CrdtServer, Repository, MinimalWebSocket } from "../server/crdtServer.js";
import { CrdtEvent } from "../eventGraph/eventGraph.js";
import { Doc } from "../crdtTypes/doc.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];
  async getEvents(): Promise<CrdtEvent[]> { return this.events; }
  async saveEvents(events: CrdtEvent[]): Promise<void> { this.events.push(...events); }
  async clearEvents(): Promise<void> { this.events = []; }
}

class MockWebSocket implements MinimalWebSocket {
  readyState = 1;
  send() {}
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  
  private listeners: Record<string, ((arg?: unknown) => void)[]> = { message: [], close: [], error: [] };
  
  on(event: string, cb: (arg?: unknown) => void) {
    this.listeners[event].push(cb);
  }
  
  emit(event: string, arg?: unknown) {
    this.listeners[event].forEach(cb => cb(arg));
  }
}

describe("Memory Leak Benchmarks", () => {
  bench("Connect, sync, disconnect 1000 clients", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("room-mem", repo);
    await server.initialize();

    for (let i = 0; i < 1000; i++) {
      const ws = new MockWebSocket();
      await server.handleConnection(ws);
      ws.close();
    }
  }, { time: 5000, iterations: 10 });
});

/**
 * PLAN_13.1 — single long-lived client with NO snapshot reset.
 *
 * A client that stays connected to an active document accumulates event-graph
 * entries and undo closures with no server compaction to reset it. This drives
 * one {@link Doc} through many interleaved local + remote ops (keys are reused
 * so the *document* stays O(1) and the measured growth isolates the event graph
 * and undo cache rather than user data). The undo stack is now bounded, so its
 * contribution is capped; the event graph is not (Action 4, deferred).
 *
 * `runNoResetSession` is exported so the accompanying heap-growth measurement
 * script can quantify growth outside the bench harness.
 */
export function runNoResetSession(n: number, undoStackLimit?: number): Doc {
  const local = new Doc("bench-local");
  const remote = new Doc("bench-remote");
  if (undoStackLimit !== undefined) {
    local.egWalker.setUndoStackLimit(undoStackLimit);
  }

  let localVersion = local.egWalker.getVersion();
  let remoteVersion = remote.egWalker.getVersion();

  for (let i = 0; i < n; i++) {
    // Local edit and a concurrent remote edit, exchanged each round so the
    // client's graph is continuously extended with concurrent suffixes.
    local.getMap().set("localCounter", i);
    remote.getMap().set("remoteCounter", i);

    const localNew: CrdtEvent[] = local.egWalker.graph.getChangesSince(localVersion);
    const remoteNew: CrdtEvent[] = remote.egWalker.graph.getChangesSince(remoteVersion);

    local.egWalker.integrateRemote(remoteNew);
    remote.egWalker.integrateRemote(localNew);

    localVersion = local.egWalker.getVersion();
    remoteVersion = remote.egWalker.getVersion();
  }

  return local;
}

describe("PLAN_13 — long-lived client (no snapshot reset)", () => {
  const N = 5_000;

  // Bounded undo stack (default cap): the retained undo cache stops growing
  // once the cap is reached even as the session runs indefinitely.
  bench("single client, bounded undo stack", () => {
    runNoResetSession(N);
  }, { time: 3000, iterations: 5 });

  // Effectively-unbounded undo stack for comparison: one undo closure is
  // retained per applied event for the whole session.
  bench("single client, unbounded undo stack", () => {
    runNoResetSession(N, Number.MAX_SAFE_INTEGER);
  }, { time: 3000, iterations: 5 });
});
