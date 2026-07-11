import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";

describe("YMap Delete Operations", () => {
	it("should delete a key locally and be undefined", () => {
		const doc = new Doc("replica-1");
		const map = doc.getMap();
		map.set("key1", "value1");
		expect(map.get("key1")).toBe("value1");

		map.delete("key1");
		expect(map.get("key1")).toBeUndefined();
	});

	it("should replicate delete operation to another document", () => {
		const doc1 = new Doc("replica-1");
		const doc2 = new Doc("replica-2");
		const map1 = doc1.getMap();

		const setEvent = map1.set("keyA", "valueA");
		doc2.egWalker.integrateRemote([setEvent]);
		expect(doc2.getMap().get("keyA")).toBe("valueA");

		const deleteEvent = map1.delete("keyA");
		doc2.egWalker.integrateRemote([deleteEvent]);
		expect(doc2.getMap().get("keyA")).toBeUndefined();
	});

	it("should resolve concurrent set and delete deterministically", () => {
		const doc1 = new Doc("replica-1");
		const doc2 = new Doc("replica-2");

		const setEvent = doc1.getMap().set("keyA", "initial");
		doc2.egWalker.integrateRemote([setEvent]);

		// doc1 deletes, doc2 updates
		const deleteEvent = doc1.getMap().delete("keyA");
		const updateEvent = doc2.getMap().set("keyA", "updated");

		doc1.egWalker.integrateRemote([updateEvent]);
		doc2.egWalker.integrateRemote([deleteEvent]);

		// Both docs should end up in the same state
		expect(doc1.getMap().get("keyA")).toEqual(doc2.getMap().get("keyA"));
	});

	it("should retain a tombstone that prevents an older concurrent set from overwriting it", () => {
		const doc1 = new Doc("replica-1");
		const doc2 = new Doc("replica-2");

		// doc1 sets: "replica-1:0"
		const setEvent = doc1.getMap().set("keyA", "updated-by-1");
		
		// doc2 deletes: "replica-2:0"
		const deleteEvent = doc2.getMap().delete("keyA");

		// compareEventIds("replica-2:0", "replica-1:0") > 0.
		// So doc2's delete should win.
		
		// Replicate doc1's set to doc2. doc2 already deleted it, and its delete event ID is larger.
		// Therefore, the set should be ignored.
		doc2.egWalker.integrateRemote([setEvent]);
		expect(doc2.getMap().get("keyA")).toBeUndefined(); // Should still be deleted

		// Replicate doc2's delete to doc1. doc1 already set it, but doc2's delete event ID is larger.
		// Therefore, the delete should overwrite the set.
		doc1.egWalker.integrateRemote([deleteEvent]);
		expect(doc1.getMap().get("keyA")).toBeUndefined();
	});
});

