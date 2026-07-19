import { describe, expect, it, vi } from "vitest";
import { CrdtServer, MinimalWebSocket, Repository } from "../crdtServer.js";
import { InMemoryPubSubAdapter } from "../pubSubAdapter.js";
import { CrdtEvent, Doc } from "../../index.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];
  saveEventsCalls = 0;
  getEventsCalls = 0;
  clearEventsCalls = 0;
  shouldFail = false;

  async getEvents(): Promise<CrdtEvent[]> {
    this.getEventsCalls++;
    return this.events;
  }

  async saveEvents(events: CrdtEvent[]): Promise<void> {
    if (this.shouldFail) {
      throw new Error("Simulated database write error");
    }
    this.saveEventsCalls++;
    this.events.push(...events);
  }

  async clearEvents(): Promise<void> {
    this.events = [];
    this.saveEventsCalls = 0;
  }
}

class MockWebSocket implements MinimalWebSocket {
  sentData: string[] = [];
  readyState = 1; // OPEN
  closeCalled = 0;

  private messageListeners: ((data: unknown) => void)[] = [];
  private closeListeners: (() => void)[] = [];
  private errorListeners: ((err: unknown) => void)[] = [];

  send(data: string): void {
    this.sentData.push(data);
  }

  close(): void {
    this.closeCalled++;
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "message" | "close" | "error", cb: unknown): void {
    if (event === "message") {
      this.messageListeners.push(cb as (data: unknown) => void);
    } else if (event === "close") {
      this.closeListeners.push(cb as () => void);
    } else if (event === "error") {
      this.errorListeners.push(cb as (err: unknown) => void);
    }
  }

  emit(event: "message", data: unknown): void;
  emit(event: "close"): void;
  emit(event: "error", err: unknown): void;
  emit(event: "message" | "close" | "error", arg?: unknown): void {
    if (event === "message") {
      this.messageListeners.forEach((cb) => cb(arg));
    } else if (event === "close") {
      this.closeListeners.forEach((cb) => cb());
    } else if (event === "error") {
      this.errorListeners.forEach((cb) => cb(arg));
    }
  }
}

describe("CrdtServer", () => {
  it("should initialize the document with an initial event if repository is empty", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo);

    await server.initialize();

    expect(repo.events.length).toBe(1);
    expect(repo.events[0].op.type).toBe("array-insert");
  });

  it("should handle connections and broadcast events", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo);
    await server.initialize();

    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    await server.handleConnection(ws1);
    await server.handleConnection(ws2);

    // Initial snapshot is sent on connection
    expect(ws1.sentData.length).toBe(1);
    const parsedSnapshot = JSON.parse(ws1.sentData[0]);
    expect(parsedSnapshot.type).toBe("snapshot");

    // Simulate sending an event from ws1
    const localDoc = server.getDoc();
    localDoc.getMap().getArray("content").insert(0, ["a"]);
    const events1 = localDoc.egWalker.getStateSnapshot().graph.events;
    const dummyEvent = events1[events1.length - 1][1];

    ws1.emit("message", JSON.stringify(dummyEvent));

    // Wait a brief tick for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    // ws2 should have received the event
    expect(ws2.sentData.length).toBe(2); // snapshot + event
    const parsedEvent = JSON.parse(ws2.sentData[1]);
    expect(parsedEvent.type).toBe("event");
    expect(parsedEvent.data.id).toBe(dummyEvent!.id);
  });

  it("should not double-apply events on re-initialization after all clients disconnect", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo);
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    // Make an edit as a client would: build the event on a separate doc that has
    // synced the server's state, then deliver it over the socket. (Applying it
    // directly to the server's own doc first would make it a duplicate, which the
    // server correctly refuses to re-persist.)
    const clientDoc = new Doc("client-1");
    clientDoc.egWalker.integrateRemote(
      server.getDoc().egWalker.graph.getAllEvents(),
    );
    clientDoc.getMap().getArray("content").insert(0, ["a"]);
    const events2 = clientDoc.egWalker.getStateSnapshot().graph.events;
    const dummyEvent = events2[events2.length - 1][1];
    ws1.emit("message", JSON.stringify(dummyEvent));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(server.getDoc().getMap().getArray("content")?.toJSON()).toEqual([
      "a",
    ]);
    expect(repo.events.length).toBe(2); // init event + "a"

    // Disconnect all clients
    ws1.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Connect new client, triggering re-initialization
    const ws2 = new MockWebSocket();
    await server.handleConnection(ws2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // State should remain ["a"], not ["a", "a"]
    expect(server.getDoc().getMap().getArray("content")?.toJSON()).toEqual([
      "a",
    ]);
  });
});

describe("Security Hardening Limits", () => {
  it("should reject oversized messages", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo, {
      maxMessageSize: 100, // Very small limit for testing
    });
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a message > 100 bytes
    const largeMessage = JSON.stringify({
      type: "dummy",
      data: "x".repeat(150),
    });
    ws1.emit("message", largeMessage);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rejected oversized message"),
    );
    expect(repo.events.length).toBe(1); // Only the initial event, nothing was saved

    warnSpy.mockRestore();
  });

  it("should silently drop events with malformed IDs without crashing", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo);
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const initialEventsCount = repo.events.length;

    // Emit event with invalid ID "foo"
    ws1.emit(
      "message",
      JSON.stringify({
        id: "foo",
        replicaId: "client1",
        parents: [],
        op: { type: "map-set", path: [], key: "k", value: "v" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(repo.events.length).toBe(initialEventsCount); // No new event should be saved
    expect(warnSpy).toHaveBeenCalledWith(
      "Rejected invalid event from client:",
      expect.any(Object),
    );

    warnSpy.mockRestore();
  });

  it("should apply rate limits to sockets", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo, {
      maxEventsPerSecond: 2,
    });
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Send 3 events quickly
    for (let i = 0; i < 3; i++) {
      ws1.emit(
        "message",
        JSON.stringify({
          type: "awareness",
          data: { replicaId: "client1", state: {} },
        }),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rate limit exceeded for socket"),
    );

    warnSpy.mockRestore();
  });

  it("should reject operations that exceed specific limits", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo, {
      maxArrayInsertSize: 2,
      maxTextInsertSize: 5,
      maxValueSize: 10,
    });
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 1. array-insert
    ws1.emit(
      "message",
      JSON.stringify({
        id: "client1:1",
        replicaId: "client1",
        parents: [],
        op: {
          type: "array-insert",
          path: [],
          afterId: null,
          values: [1, 2, 3],
        },
      }),
    );

    // 2. text-insert
    ws1.emit(
      "message",
      JSON.stringify({
        id: "client1:2",
        replicaId: "client1",
        parents: [],
        op: { type: "text-insert", path: [], afterId: null, text: "too long" },
      }),
    );

    // 3. map-set
    ws1.emit(
      "message",
      JSON.stringify({
        id: "client1:3",
        replicaId: "client1",
        parents: [],
        op: {
          type: "map-set",
          path: [],
          key: "k",
          value: "this is larger than 10 bytes",
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rejected array-insert"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rejected text-insert"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rejected map-set"),
    );

    warnSpy.mockRestore();
  });

  it("should synchronously close the connection on repeated violations to prevent DoS", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("default-room", repo, {
      maxMessageSize: 100, // Small limit
      maxEventsPerSecond: 10,
    });
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const largeMessage = JSON.stringify({
      type: "dummy",
      data: "x".repeat(150),
    });

    // Fire 1000 synchronous large messages
    for (let i = 0; i < 1000; i++) {
      ws1.emit("message", largeMessage);
    }

    // The socket should have been closed after 5 violations
    expect(ws1.closeCalled).toBeGreaterThan(0);

    // The messageQueue should not have ballooned
    expect(
      (server as unknown as { messageQueue: unknown[] }).messageQueue.length,
    ).toBe(0);

    warnSpy.mockRestore();
  });
});

describe("Clustered execution via InMemoryPubSubAdapter", () => {
  it("should synchronize state between multiple CrdtServer instances", async () => {
    const pubSub = new InMemoryPubSubAdapter();

    const repo1 = new MockRepository();
    const repo2 = new MockRepository();

    const server1 = new CrdtServer("shared-room", repo1, { pubSub });
    await server1.initialize();

    // Copy initial events from repo1 to repo2 to simulate a shared DB boot state
    repo2.events = [...repo1.events];

    const server2 = new CrdtServer("shared-room", repo2, { pubSub });
    await server2.initialize();

    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    await server1.handleConnection(ws1);
    await server2.handleConnection(ws2);

    // Initial snapshots sent
    expect(ws1.sentData.length).toBe(1);
    expect(ws2.sentData.length).toBe(1);

    // Send local edit on server1
    server1.getDoc().getMap().getArray("content").insert(0, ["a"]);
    const events3 = server1.getDoc().egWalker.getStateSnapshot().graph.events;
    const dummyEvent = events3[events3.length - 1][1];
    ws1.emit("message", JSON.stringify(dummyEvent));

    // Wait for microtasks (to let pubsub broadcast and async events settle)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // WS2 on Server2 should have received the event broadcasted from Server1 via PubSub
    expect(ws2.sentData.length).toBe(2);
    const parsedEvent = JSON.parse(ws2.sentData[1]);
    expect(parsedEvent.type).toBe("event");
    expect(parsedEvent.data.id).toBe(dummyEvent!.id);

    // Doc states on both servers must converge
    expect(server1.getDoc().getMap().getArray("content")?.toJSON()).toEqual([
      "a",
    ]);
    expect(server2.getDoc().getMap().getArray("content")?.toJSON()).toEqual([
      "a",
    ]);
  });

  it("should not double-integrate events when publishing to PubSub", async () => {
    const pubSub = new InMemoryPubSubAdapter();
    const repo1 = new MockRepository();
    const server1 = new CrdtServer("shared-room", repo1, { pubSub });
    await server1.initialize();

    const ws1 = new MockWebSocket();
    await server1.handleConnection(ws1);

    const initialEventsCount =
      server1.getDoc().egWalker.graph.getAllEvents().length;

    const localDoc = server1.getDoc();
    localDoc.getMap().getArray("content").insert(0, ["b"]);
    const events = localDoc.egWalker.getStateSnapshot().graph.events;
    const dummyEvent = events[events.length - 1][1];

    let integrateCalls = 0;
    const originalIntegrate = server1.getDoc().egWalker.integrateRemote.bind(
      server1.getDoc().egWalker,
    );
    server1.getDoc().egWalker.integrateRemote = (evs) => {
      integrateCalls++;
      originalIntegrate(evs);
    };

    ws1.emit("message", JSON.stringify(dummyEvent));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(integrateCalls).toBe(1);
    expect(server1.getDoc().egWalker.graph.getAllEvents().length).toBe(
      initialEventsCount + 1,
    );
  });
});

import { handleWebSocket, serverInstances } from "../crdtServer.js";

describe("serverInstances TTL", () => {
  it("should remove server from global map after idle timeout", async () => {
    const repo = new MockRepository();
    const ws1 = new MockWebSocket();

    // Connect first client
    await handleWebSocket(ws1, "ttl-room", repo, { idleTimeoutMs: 10 });
    expect(serverInstances.has("ttl-room")).toBe(true);

    // Disconnect
    ws1.emit("close");

    // Wait for the real timer (10ms) to fire + some buffer
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify it was removed
    expect(serverInstances.has("ttl-room")).toBe(false);
  });

  it("rejects oversized awareness payloads (B13)", async () => {
    const repo = new MockRepository();
    const ws = new MockWebSocket();
    const errors: string[] = [];
    const server = new CrdtServer("aw-size-room", repo, {
      maxAwarenessStateSize: 100,
      onError: (ctx) => errors.push(ctx),
    });
    await server.handleConnection(ws);

    ws.emit(
      "message",
      JSON.stringify({ type: "awareness", data: { replicaId: "peer", state: "x".repeat(500) } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.getDoc().egWalker.getAwareness("peer")).toBeUndefined();
    expect(errors.some((e) => /awareness/i.test(e))).toBe(true);
  });

  it("caps the number of replica ids a single socket may register for awareness (B13)", async () => {
    const repo = new MockRepository();
    const ws = new MockWebSocket();
    const server = new CrdtServer("aw-count-room", repo, { maxReplicaIdsPerSocket: 2 });
    await server.handleConnection(ws);

    for (const id of ["p1", "p2", "p3"]) {
      ws.emit(
        "message",
        JSON.stringify({ type: "awareness", data: { replicaId: id, state: { at: id } } }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.getDoc().egWalker.getAwareness("p1")).toBeDefined();
    expect(server.getDoc().egWalker.getAwareness("p2")).toBeDefined();
    expect(server.getDoc().egWalker.getAwareness("p3")).toBeUndefined();
  });

  it("a stale idle timer does not evict a replacement instance (B8)", async () => {
    const repo = new MockRepository();
    const wsA = new MockWebSocket();
    await handleWebSocket(wsA, "b8-room", repo, { idleTimeoutMs: 30 });
    const serverA = serverInstances.get("b8-room");
    expect(serverA).toBeDefined();

    // Last socket disconnects -> schedules A's idle-eviction timer.
    wsA.emit("close");

    // Before A's timer fires, the room is evicted and a fresh client reconnects,
    // creating a brand-new instance B that owns the room key.
    serverInstances.delete("b8-room");
    const wsB = new MockWebSocket();
    await handleWebSocket(wsB, "b8-room", repo, { idleTimeoutMs: 30 });
    const serverB = serverInstances.get("b8-room");
    expect(serverB).not.toBe(serverA);

    // Wait past A's (stale) timer.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // B — which still has a live socket — must NOT have been evicted by A's timer.
    expect(serverInstances.get("b8-room")).toBe(serverB);

    // Cleanup.
    wsB.emit("close");
    serverInstances.delete("b8-room");
  });

  it("compaction invoked externally serialises and leaves no orphaned events (B6)", async () => {
    const repo = new MockRepository();
    const ws = new MockWebSocket();
    const server = new CrdtServer("b6-room", repo, { compactionThreshold: 1000 });
    await server.handleConnection(ws);

    // Push several events, then compact via the public (queue-routed) entry.
    const base = server.getDoc().egWalker.getVersion();
    void base;
    for (let i = 0; i < 3; i++) {
      server.getDoc().getMap().getArray("content").insert(0, [`v${i}`]);
    }
    await server.compact();

    // A few more events after compaction.
    server.getDoc().getMap().getArray("content").insert(0, ["after"]);

    // Persist current graph, then reload into a fresh server: every persisted
    // event must be replayable (no dangling parents => zero pending).
    await repo.saveEvents(server.getDoc().egWalker.graph.getAllEvents());
    const reload = new CrdtServer("b6-room", repo);
    await reload.initialize();
    expect(reload.getDoc().egWalker.getPendingEventCount()).toBe(0);
  });
});
