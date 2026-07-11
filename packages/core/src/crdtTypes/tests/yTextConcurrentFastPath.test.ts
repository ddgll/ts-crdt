import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";

describe("YText concurrent insert fast path", () => {
    it("should produce identical results via fast path and full rebuild", () => {
        // Setup: two replicas with shared initial state "A"
        const doc1 = new Doc("replica1");
        const doc2 = new Doc("replica2");
        doc1.getMap().getText("text").insert(0, "A");
        doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

        // Concurrent inserts after "A"
        doc1.getMap().getText("text").insert(1, "B");
        doc2.getMap().getText("text").insert(1, "C");

        // Sync — this should hit the fast path on one replica
        const doc1Events = doc1.egWalker.graph.getAllEvents();
        const doc2Events = doc2.egWalker.graph.getAllEvents();
        doc1.egWalker.integrateRemote(doc2Events);
        doc2.egWalker.integrateRemote(doc1Events);

        // Both must converge
        expect(doc1.getMap().getText("text").toString())
            .toEqual(doc2.getMap().getText("text").toString());

        // Verify against a fresh rebuild
        const doc3 = new Doc("replica3");
        doc3.egWalker.integrateRemote([...doc1Events, ...doc2Events]);
        expect(doc1.getMap().getText("text").toString())
            .toEqual(doc3.getMap().getText("text").toString());
    });
});
