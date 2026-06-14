import { describe, it, expect } from "vitest";
import { CrdtServer, Repository, MinimalWebSocket } from "../crdtServer.js";
import { CrdtEvent } from "../index.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];

  async getEvents(): Promise<CrdtEvent[]> {
    return this.events;
  }

  async saveEvent(event: CrdtEvent): Promise<void> {
    this.events.push(event);
  }

  async clearEvents(): Promise<void> {
    this.events = [];
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
    const server = new CrdtServer(repo);

    await server.initialize();

    expect(repo.events.length).toBe(1);
    expect(repo.events[0].op.type).toBe("array-insert");
  });

  it("should handle connections and broadcast events", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer(repo);
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
    const dummyEvent = localDoc.localInsert(["content"], 0, ["a"]);

    ws1.emit("message", JSON.stringify(dummyEvent));

    // Wait a brief tick for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    // ws2 should have received the event
    expect(ws2.sentData.length).toBe(2); // snapshot + event
    const parsedEvent = JSON.parse(ws2.sentData[1]);
    expect(parsedEvent.type).toBe("event");
    expect(parsedEvent.data.id).toBe(dummyEvent!.id);
  });
});
