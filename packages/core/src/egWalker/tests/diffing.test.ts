import { describe, it, expect, vi } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";

describe("Single-event state diffing for concurrent edits", () => {
	it("should NOT rebuild state when concurrent event sorts at the end", () => {
		const docA = new Doc("replicaA");
		const docB = new Doc("replicaB");

		// Initial common state
		docA.getMap().set("key1", "val1");
		const event1 = docA.egWalker.graph.getEvents(docA.egWalker.graph.getVersion())[0];
		docB.egWalker.integrateRemote([event1]);

		// Spy on doc._setRoot to detect full rebuilds
		const setRootSpyA = vi.spyOn(docA, "_setRoot");

		// Replica A creates a local edit (event2)
		docA.getMap().set("key2", "A");
		const event2 = docA.egWalker.graph.getChangesSince([event1.id])[0];

		// Replica B creates a local edit concurrently (event3)
		docB.getMap().set("key3", "B");
		const event3 = docB.egWalker.graph.getChangesSince([event1.id])[0];

		// Because replicaB > replicaA in string sort, event3 (from B) will sort AFTER event2 (from A).
		// Therefore, when A integrates event3, it should just append it without rebuilding.
		docA.egWalker.integrateRemote([event3]);

		// Ensure it didn't rebuild (doc._setRoot is called during full rebuild)
		expect(setRootSpyA).not.toHaveBeenCalled();
		expect(docA.getMap().get("key2")).toBe("A");
		expect(docA.getMap().get("key3")).toBe("B");
	});

	it("should rebuild state when concurrent event sorts in the middle", () => {
		const docA = new Doc("replicaA");
		const docB = new Doc("replicaB");

		// Initial common state
		docA.getMap().set("key1", "val1");
		const event1 = docA.egWalker.graph.getEvents(docA.egWalker.graph.getVersion())[0];
		docB.egWalker.integrateRemote([event1]);

		// Spy on doc._setRoot to detect full rebuilds
		const setRootSpyB = vi.spyOn(docB, "_setRoot");

		// Replica A creates a local edit (event2)
		docA.getMap().set("key2", "A");
		const event2 = docA.egWalker.graph.getChangesSince([event1.id])[0];

		// Replica B creates a local edit concurrently (event3)
		docB.getMap().set("key3", "B");
		const event3 = docB.egWalker.graph.getChangesSince([event1.id])[0];

		// Because replicaB > replicaA in string sort, event3 (from B) sorts AFTER event2 (from A).
		// Therefore, when B integrates event2, event2 sorts BEFORE event3.
		// This forces a rebuild because the new event is inserted in the middle of the history.
		docB.egWalker.integrateRemote([event2]);

		// Ensure it DID rebuild
		expect(setRootSpyB).toHaveBeenCalled();
		expect(docB.getMap().get("key2")).toBe("A");
		expect(docB.getMap().get("key3")).toBe("B");
	});
});
