import { describe, it, expect } from 'vitest';
import { CrdtServer, Repository, MinimalWebSocket } from "../crdtServer.js";
import { CrdtEvent } from "../../index.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];
  
  async getEvents(): Promise<CrdtEvent[]> {
    return this.events;
  }

  async saveEvents(events: CrdtEvent[]): Promise<void> {
    this.events.push(...events);
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
    if (this.readyState === 1) {
      this.sentData.push(data);
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "message" | "close" | "error", cb: unknown): void {
    if (event === "message") this.messageListeners.push(cb as (data: unknown) => void);
    else if (event === "close") this.closeListeners.push(cb as () => void);
    else if (event === "error") this.errorListeners.push(cb as (err: unknown) => void);
  }

  emit(event: "message", data: unknown): void;
  emit(event: "close"): void;
  emit(event: "error", err: unknown): void;
  emit(event: "message" | "close" | "error", arg?: unknown): void {
    if (event === "message") this.messageListeners.forEach((cb) => cb(arg));
    else if (event === "close") this.closeListeners.forEach((cb) => cb());
    else if (event === "error") this.errorListeners.forEach((cb) => cb(arg));
  }
}

describe("Connection Edge Cases", () => {
  it("should not leak memory if socket is closed abruptly via error", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("room1", repo);
    await server.initialize();

    const ws1 = new MockWebSocket();
    await server.handleConnection(ws1);

    expect((server as unknown as { sockets: Set<unknown> }).sockets.size).toBe(1);

    ws1.emit("error", new Error("ECONNRESET"));
    // The server listens to "error" and typically cleans up, or ignores it. 
    // Usually, underlying socket frameworks close on error. Let's assume we must manually close.
    ws1.emit("close"); 

    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect((server as unknown as { sockets: Set<unknown> }).sockets.size).toBe(0);
  });

  it("should ignore messages sent after socket closes", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("room2", repo);
    await server.initialize();

    const ws = new MockWebSocket();
    await server.handleConnection(ws);
    
    ws.emit("close");
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const initialEvents = repo.events.length;
    
    // Emit message after close
    ws.emit("message", JSON.stringify({ type: "event", data: { id: "fake:1", op: { type: "array-insert", path: ["arr"], index: 0, value: ["test"] }, happenedBefore: [] } }));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(repo.events.length).toBe(initialEvents); // Should not have saved any events
  });
});
