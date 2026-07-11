import { describe, it, expect, vi } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";

describe("Single-event state diffing for concurrent edits", () => {
	it("should NOT rebuild state when concurrent event sorts at the end", () => {
		const docA = new Doc("replicaA");
		const docB = new Doc("replicaB");

		// Initial common state
		docA.getMap().set("key1", "val1"); // replicaA:0
		const event1 = docA.egWalker.graph.getEvents(docA.egWalker.graph.getVersion())[0];
		docB.egWalker.integrateRemote([event1]);

		// Spy on doc._setRoot to detect full rebuilds
		const setRootSpyB = vi.spyOn(docB, "_setRoot");

		// Replica A creates a local edit (event2 -> replicaA:1)
		docA.getMap().set("key2", "A");
		const event2 = docA.egWalker.graph.getChangesSince([event1.id])[0];

		// Replica B creates a local edit concurrently (event3 -> replicaB:0)
		docB.getMap().set("key3", "B");

		// Because seq 1 > seq 0, event2 (replicaA:1) sorts AFTER event3 (replicaB:0).
		// Therefore, when B integrates event2, it just appends it without rebuilding.
		docB.egWalker.integrateRemote([event2]);

		// Ensure it didn't rebuild (doc._setRoot is called during full rebuild)
		expect(setRootSpyB).not.toHaveBeenCalled();
		expect(docB.getMap().get("key2")).toBe("A");
		expect(docB.getMap().get("key3")).toBe("B");
	});

	it("should rebuild state when concurrent event sorts in the middle", () => {
		const docA = new Doc("replicaA");
		const docB = new Doc("replicaB");

		// Initial common state
		docA.getMap().set("key1", "val1"); // replicaA:0
		const event1 = docA.egWalker.graph.getEvents(docA.egWalker.graph.getVersion())[0];
		docB.egWalker.integrateRemote([event1]);

		// Spy on doc._setRoot to detect full rebuilds
		const setRootSpyA = vi.spyOn(docA, "_setRoot");

		// Replica A creates a local edit (event2 -> replicaA:1)
		docA.getMap().set("key2", "A");

		// Replica B creates a local edit concurrently (event3 -> replicaB:0)
		docB.getMap().set("key3", "B");
		const event3 = docB.egWalker.graph.getChangesSince([event1.id])[0];

		// Because seq 0 < seq 1, event3 (replicaB:0) sorts BEFORE event2 (replicaA:1).
		// Therefore, when A integrates event3, it has to rebuild the state because event3
		// sorts before A's local event.
		docA.egWalker.integrateRemote([event3]);

		// Ensure it did rebuild
		expect(setRootSpyA).toHaveBeenCalled();
		expect(docA.getMap().get("key2")).toBe("A");
		expect(docA.getMap().get("key3")).toBe("B");
	});
});
