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

	it("should not advance the sequence number to the snapshot's creator sequence if created by a different replica", () => {
		const doc1 = new Doc("replica-1");
		for (let i = 0; i < 5; i++) {
			doc1.getMap().set(`key${i}`, `val${i}`);
		}
		// doc1 seq is now 5
		const snapshot = doc1.egWalker.getStateSnapshot();

		const doc2 = new Doc("replica-2");
		// doc2 seq is 0
		doc2.egWalker.loadStateSnapshot(snapshot);

		// Creating a new local op should use sequence number 0 for replica-2
		const event = doc2.getMap().set("keyA", "valA");
		expect(event.id).toBe("replica-2:0");
	});
});
