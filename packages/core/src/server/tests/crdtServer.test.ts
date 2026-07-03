import { describe, it, expect } from 'vitest';
import { CrdtServer, Repository, MinimalWebSocket } from "../crdtServer.js";
import { InMemoryPubSubAdapter } from "../pubSubAdapter.js";
import { CrdtEvent } from "../../index.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];
  saveEventsCalls = 0;
  shouldFail = false;

  async getEvents(): Promise<CrdtEvent[]> {
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
  
  private messageListeners: ((data: unknown) => void)[] = [];
  private closeListeners: (() => void)[] = [];
  private errorListeners: ((err: unknown) => void)[] = [];

  send(data: string): void {
    this.sentData.push(data);
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

    // Make an edit
    const localDoc = server.getDoc();
    localDoc.getMap().getArray("content").insert(0, ["a"]);
    const events2 = localDoc.egWalker.getStateSnapshot().graph.events;
    const dummyEvent = events2[events2.length - 1][1];
    ws1.emit("message", JSON.stringify(dummyEvent));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(server.getDoc().getMap().getArray("content")?.toJSON()).toEqual(["a"]);
    expect(repo.events.length).toBe(2); // init event + "a"

    // Disconnect all clients
    ws1.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Connect new client, triggering re-initialization
    const ws2 = new MockWebSocket();
    await server.handleConnection(ws2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // State should remain ["a"], not ["a", "a"]
    expect(server.getDoc().getMap().getArray("content")?.toJSON()).toEqual(["a"]);
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
    expect(server1.getDoc().getMap().getArray("content")?.toJSON()).toEqual(["a"]);
    expect(server2.getDoc().getMap().getArray("content")?.toJSON()).toEqual(["a"]);
  });
});
