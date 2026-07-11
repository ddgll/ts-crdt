import { describe, it, expect } from 'vitest';
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

  it("should prevent concurrent compactions from executing simultaneously", async () => {
    let savedEvents: CrdtEvent[] = [];
    let saveCount = 0;
    const mockRepo: Repository = {
      getEvents: async () => savedEvents,
      saveEvents: async (events) => {
        saveCount++;
        // Simulate some I/O delay
        await new Promise(resolve => setTimeout(resolve, 50));
        savedEvents.push(...events);
      },
      clearEvents: async () => {
        savedEvents = [];
      }
    };

    const server = new CrdtServer("test-room-2", mockRepo, { compactionThreshold: 5 });
    await server.initialize();
    
    // Create events to allow compaction
    const doc = new Doc("client-2");
    doc.egWalker.integrateRemote(
      server.getDoc().egWalker.graph.topologicalSort(
        server.getDoc().egWalker.graph.getEvents(server.getDoc().egWalker.getVersion())
      )
    );
    doc.getMap().set("key1", "val1");
    doc.getMap().set("key2", "val2");
    doc.getMap().set("key3", "val3");
    doc.getMap().set("key4", "val4");
    doc.getMap().set("key5", "val5");
    const eventsToIntegrate = doc.egWalker.graph.topologicalSort(
      doc.egWalker.graph.getEvents(doc.egWalker.getVersion())
    );
    server.getDoc().egWalker.integrateRemote(eventsToIntegrate);
    
    expect(server.getDoc().egWalker.graph.getEvents(server.getDoc().egWalker.getVersion()).length).toBe(6);

    // Call compact() concurrently
    // Since isCompacting guards the method, only one should pass the check and actually call saveEvents
    const p1 = server.compact();
    const p2 = server.compact();
    const p3 = server.compact();
    
    await Promise.all([p1, p2, p3]);

    // saveEvents is called inside compact() once during clearEvents & saveEvents
    // Plus 1 initial event during initialization if it was empty, but we initialized it first before setting count to 0? No, saveEvents is called during init if it creates a root event.
    // Let's just check saveCount.
    // Init creates root event: saveCount = 1
    // Compact: saveCount = 2
    // If it ran 3 times concurrently, saveCount would be 4.
    expect(saveCount).toBe(2);
  });

  it("should not block incoming events during a slow database compaction", async () => {
    let savedEvents: CrdtEvent[] = [];
    let isCompactingDb = false;
    
    const mockRepo: Repository = {
      getEvents: async () => savedEvents,
      saveEvents: async (events) => {
        savedEvents.push(...events);
      },
      clearEvents: async () => {
        isCompactingDb = true;
        savedEvents = [];
        // Simulate a slow database clear
        await new Promise(resolve => setTimeout(resolve, 50));
        isCompactingDb = false;
      }
    };

    const server = new CrdtServer("test-room-3", mockRepo, { compactionThreshold: 5 });
    await server.initialize();
    
    const doc = new Doc("client-3");
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
    map.set("key5", "val5"); // The 5th event that will trigger compaction
    
    const eventsToIntegrate = doc.egWalker.graph.topologicalSort(
      doc.egWalker.graph.getEvents(doc.egWalker.getVersion())
    );
    
    let messageCallback: (data: string) => void = () => {};
    const mockSocket: any = {
      readyState: 1,
      send: (msgString: string) => {
        const msg = JSON.parse(msgString);
        if (msg.type === "snapshot") {
          doc.egWalker.loadStateSnapshot(msg.data);
        }
      },
      on: (event: string, cb: any) => {
        if (event === "message") messageCallback = cb;
      },
    };
    
    await server.handleConnection(mockSocket);
    
    // Send 5 events to trigger compaction
    for (let i = 0; i < 5; i++) {
      const e = eventsToIntegrate.find(e => e.op.type === "map-set" && e.op.key === `key${i+1}`);
      if (e) {
        messageCallback(JSON.stringify({ type: "event", data: e }));
      }
    }
    
    // At this point, the server starts compacting in the background, but the queue is still processing.
    // Wait a tiny bit for the queue to start compaction
    await new Promise(resolve => setTimeout(resolve, 15));
    
    expect(isCompactingDb).toBe(true); // Compaction is ongoing
    
    // Now send a 6th event
    map.set("key6", "val6");
    const e6 = doc.egWalker.graph.getEvents(doc.egWalker.getVersion()).find(e => e.op.type === "map-set" && e.op.key === "key6")!;
    
    messageCallback(JSON.stringify({ type: "event", data: e6 }));
    
    // Wait a tiny bit for the queue to process it
    await new Promise(resolve => setTimeout(resolve, 5));
    
    // The server's in-memory state should have it, even though DB compaction is still ongoing
    expect(server.getDoc().getMap().get("key6")).toBe("val6");
    
    // Wait for DB compaction to finish
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // DB should have 2 events: the snapshot, and key6
    expect(isCompactingDb).toBe(false);
    expect(savedEvents.length).toBe(2);
  });
});
