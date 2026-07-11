import { bench, describe } from 'vitest';
import { CrdtServer, Repository, MinimalWebSocket } from "../server/crdtServer.js";
import { CrdtEvent } from "../eventGraph/eventGraph.js";
import { Doc } from "../crdtTypes/doc.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];
  async getEvents(): Promise<CrdtEvent[]> { return this.events; }
  async saveEvents(events: CrdtEvent[]): Promise<void> { this.events.push(...events); }
}

class MockWebSocket implements MinimalWebSocket {
  readyState = 1;
  send() {}
  close() {}
  private listeners: Record<string, ((arg?: unknown) => void)[]> = { message: [], close: [], error: [] };
  on(event: string, cb: (arg?: unknown) => void) { this.listeners[event].push(cb); }
  emit(event: string, arg?: unknown) { this.listeners[event].forEach(cb => cb(arg)); }
}

describe("High Concurrency Benchmarks", () => {
  bench("50 clients syncing 10 events each concurrently", async () => {
    const repo = new MockRepository();
    const server = new CrdtServer("room-concurrent", repo);
    await server.initialize();

    const NUM_CLIENTS = 50;
    const sockets: MockWebSocket[] = [];
    
    // Connect clients
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const ws = new MockWebSocket();
      await server.handleConnection(ws);
      sockets.push(ws);
    }

    // Prepare events
    const docs = Array.from({ length: NUM_CLIENTS }).map((_, i) => new Doc(`client-${i}`));
    const eventsPerClient = docs.map(doc => {
      const arr = doc.getMap().getArray("arr");
      for(let i = 0; i < 10; i++) arr.insert(arr.length, [i]);
      return doc.egWalker.getStateSnapshot().graph.events.slice(1).map(e => e[1]);
    });

    // Fire events concurrently
    const promises = [];
    for (let i = 0; i < NUM_CLIENTS; i++) {
      for (const event of eventsPerClient[i]) {
        if (event) {
          promises.push(
            new Promise<void>(resolve => {
              sockets[i].emit("message", JSON.stringify({ type: "event", data: event }));
              resolve();
            })
          );
        }
      }
    }

    await Promise.all(promises);
    
    // Process async handlers internally
    await new Promise(resolve => setTimeout(resolve, 0));
    
  }, { time: 5000 });
});
