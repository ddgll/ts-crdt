import { bench, describe } from 'vitest';
import { Doc } from "../crdtTypes/doc.js";
import { YArray } from "../crdtTypes/yArray.js";
import { CrdtServer, Repository } from "../server/crdtServer.js";
import { CrdtEvent } from "../eventGraph/eventGraph.js";

class MockRepository implements Repository {
  async getEvents(): Promise<CrdtEvent[]> { return []; }
  async saveEvents() {}
  async clearEvents() {}
}

describe("Large Document Load Benchmarks", () => {
  const doc = new Doc("large-doc");
  const arr = doc.getMap().getArray("arr");
  
  // Create 10k events
  for (let i = 0; i < 10000; i++) {
    arr.insert(arr.length, [i]);
  }
  
  const snapshot = doc.egWalker.getStateSnapshot();
  const serializedEvents = doc.egWalker.getStateSnapshot().graph.events.map(e => e[1]);

  bench("Load 10,000 events via integrateRemote", () => {
    const newDoc = new Doc("replica");
    newDoc.egWalker.integrateRemote(serializedEvents);
  });

  bench("Load snapshot with 10,000 items", () => {
    const newDoc = new Doc("replica");
    newDoc.egWalker.loadStateSnapshot(snapshot);
  });

  bench("Server Initialization with large document", async () => {
    const repo = new MockRepository();
    repo.getEvents = async () => serializedEvents;
    
    const server = new CrdtServer("room-large", repo);
    await server.initialize();
  });
});
