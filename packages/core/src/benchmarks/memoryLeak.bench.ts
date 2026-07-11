import { bench, describe } from 'vitest';
import { CrdtServer, Repository, MinimalWebSocket } from "../server/crdtServer.js";
import { CrdtEvent } from "../eventGraph/eventGraph.js";

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
