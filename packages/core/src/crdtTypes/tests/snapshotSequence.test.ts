import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";

describe("loadStateSnapshot sequence number handling", () => {
	it("should properly advance the sequence number when loading a snapshot with local events", () => {
		const doc1 = new Doc("replica-1");
		const map1 = doc1.getMap();
		map1.set("key1", "val1");
		map1.set("key2", "val2");

		// doc1 seq is now 2
		const snapshot = doc1.egWalker.getStateSnapshot();

		const doc1Reloaded = new Doc("replica-1");
		// doc1Reloaded seq is 0
		doc1Reloaded.egWalker.loadStateSnapshot(snapshot);

		// Creating a new local op should use sequence number 2, not 0
		const event = doc1Reloaded.getMap().set("key3", "val3");
		expect(event.id).toBe("replica-1:2");
	});

	it("advances the Lamport clock past another replica's observed events on load", () => {
		const doc1 = new Doc("replica-1");
		for (let i = 0; i < 5; i++) {
			doc1.getMap().set(`key${i}`, `val${i}`);
		}
		// doc1 produced replica-1:0..replica-1:4 (max seq 4).
		const snapshot = doc1.egWalker.getStateSnapshot();

		const doc2 = new Doc("replica-2");
		doc2.egWalker.loadStateSnapshot(snapshot);

		// The clock is a Lamport clock: observing replica-1's events (up to seq 4)
		// must advance replica-2's clock so its next write causally follows them.
		// Its first op therefore gets Lamport timestamp 5, not 0 — without this,
		// a causally-later write could lose LWW to an earlier one.
		const event = doc2.getMap().set("keyA", "valA");
		expect(event.id).toBe("replica-2:5");
	});
	it("should not instantiate a corrupted CRDT instance if a user explicitly sets an object with crdtType", () => {
		const doc1 = new Doc("replica-1");
		const map1 = doc1.getMap();
		map1.set("key", { crdtType: "YMap", data: "malicious" });
		
		const snapshot = doc1.egWalker.getStateSnapshot();
		const doc2 = new Doc("replica-2");
		doc2.egWalker.loadStateSnapshot(snapshot);
		
		const reloadedMap = doc2.getMap();
		const val = reloadedMap.get("key");
		// Ensure it is loaded back as a plain object and not a corrupted YMap instance.
		expect(val).toEqual({ crdtType: "YMap", data: "malicious" });
		expect(val instanceof Object).toBe(true);
		expect((val as { get?: unknown }).get).toBeUndefined(); // Should not have CRDT methods
	});
});
