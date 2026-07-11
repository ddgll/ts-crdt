import { describe, it, expect } from 'vitest';
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtServer, Repository } from "../crdtServer.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

describe("Post-compaction operations", () => {
    it("should accept new events after compaction", async () => {
        let savedEvents: CrdtEvent[] = [];
        const mockRepo: Repository = {
            getEvents: async () => savedEvents,
            saveEvents: async (events) => { savedEvents.push(...events); },
            clearEvents: async () => { savedEvents = []; }
        };

        const server = new CrdtServer("test-room", mockRepo, { compactionThreshold: 5 });
        await server.initialize();
        
        const doc1 = new Doc("client-1");
        doc1.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
        
        // Add 6 events to trigger compaction
        for (let i = 0; i < 6; i++) {
            doc1.getMap().set(`key-${i}`, `val-${i}`);
        }
        server.getDoc().egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
        await server.compact();

        doc1.egWalker.loadStateSnapshot(server.getDoc().egWalker.getStateSnapshot());

        // Add 5 more events
        for (let i = 6; i < 11; i++) {
            doc1.getMap().set(`key-${i}`, `val-${i}`);
        }
        const newEvents2 = doc1.egWalker.graph.getSortedEvents().slice(-5);
        server.getDoc().egWalker.integrateRemote(newEvents2);

        const serverDoc = server.getDoc();
        for (let i = 0; i < 11; i++) {
            expect(serverDoc.getMap().get(`key-${i}`)).toBe(`val-${i}`);
        }
    });

    it("should allow a new client to join after compaction", async () => {
        let savedEvents: CrdtEvent[] = [];
        const mockRepo: Repository = {
            getEvents: async () => savedEvents,
            saveEvents: async (events) => { savedEvents.push(...events); },
            clearEvents: async () => { savedEvents = []; }
        };

        const server = new CrdtServer("test-room", mockRepo, { compactionThreshold: 5 });
        await server.initialize();

        const doc1 = new Doc("client-1");
        doc1.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
        for (let i = 0; i < 6; i++) {
            doc1.getMap().set(`key-${i}`, `val-${i}`);
        }
        server.getDoc().egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
        await server.compact();

        const doc2 = new Doc("client-2");
        doc2.egWalker.loadStateSnapshot(server.getDoc().egWalker.getStateSnapshot());
        for (let i = 0; i < 6; i++) {
            expect(doc2.getMap().get(`key-${i}`)).toBe(`val-${i}`);
        }
        doc2.getMap().set("key-client-2", "hello");
        const evs = doc2.egWalker.graph.getEvents([doc2.egWalker.getVersion()[0]]);
        server.getDoc().egWalker.integrateRemote(evs);
        
        expect(server.getDoc().getMap().get("key-client-2")).toBe("hello");
    });

    it("should handle multiple sequential compactions", async () => {
        let savedEvents: CrdtEvent[] = [];
        const mockRepo: Repository = {
            getEvents: async () => savedEvents,
            saveEvents: async (events) => { savedEvents.push(...events); },
            clearEvents: async () => { savedEvents = []; }
        };

        const server = new CrdtServer("test-room", mockRepo, { compactionThreshold: 5 });
        await server.initialize();

        const doc1 = new Doc("client-1");
        doc1.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());

        for (let i = 0; i < 6; i++) {
            doc1.getMap().set(`key-${i}`, `val-${i}`);
        }
        server.getDoc().egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
        await server.compact();

        doc1.egWalker.loadStateSnapshot(server.getDoc().egWalker.getStateSnapshot());

        for (let i = 6; i < 12; i++) {
            doc1.getMap().set(`key-${i}`, `val-${i}`);
        }
        const newEvents1 = doc1.egWalker.graph.getSortedEvents().slice(-6);
        server.getDoc().egWalker.integrateRemote(newEvents1);
        await server.compact();

        const serverDoc = server.getDoc();
        for (let i = 0; i < 12; i++) {
            expect(serverDoc.getMap().get(`key-${i}`)).toBe(`val-${i}`);
        }
    });
});
