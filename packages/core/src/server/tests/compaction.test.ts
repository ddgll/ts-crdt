import { describe, it, test, expect } from 'vitest';
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtServer, Repository } from "../crdtServer.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

describe("Event Graph Compaction", () => {
  it("should compact the event graph into a snapshot event", async () => {
    let savedEvents: CrdtEvent[] = [];
    const mockRepo: Repository = {
      getEvents: async () => savedEvents,
      saveEvents: async (events) => {
        savedEvents.push(...events);
      },
      clearEvents: async () => {
        savedEvents = [];
      }
    };

    const server = new CrdtServer("test-room", mockRepo, { compactionThreshold: 5 });
    await server.initialize();
    
    // Create some events locally, starting from the server's initial state
    const doc = new Doc("client-1");
    doc.egWalker.integrateRemote(
      server.getDoc().egWalker.graph.topologicalSort(
        server.getDoc().egWalker.graph.getEvents(server.getDoc().egWalker.getVersion())
      )
    );

    const map = doc.getMap();
    map.set("key1", "val1");
    map.set("key2", "val2");
    map.set("key3", "val3");
    map.set("key4", "val4");
    map.set("key5", "val5"); // This will trigger compaction if we process them
    
    // We can simulate integrating them by pushing to repo and calling compact manually
    const eventsToIntegrate = doc.egWalker.graph.topologicalSort(
      doc.egWalker.graph.getEvents(doc.egWalker.getVersion())
    );
    savedEvents.push(...eventsToIntegrate);
    
    // Force integrate on server
    server.getDoc().egWalker.integrateRemote(eventsToIntegrate);
    
    expect(server.getDoc().egWalker.graph.getEvents(server.getDoc().egWalker.getVersion()).length).toBe(6); // 1 root + 5 sets
    
    await server.compact();
    
    // Graph should now only have 1 event (the snapshot)
    const newVersion = server.getDoc().egWalker.getVersion();
    expect(server.getDoc().egWalker.graph.getEvents(newVersion).length).toBe(1);
    
    // And it should have the data
    expect(server.getDoc().getMap().get("key5")).toBe("val5");
  });
});
