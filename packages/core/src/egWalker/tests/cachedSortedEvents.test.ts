import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";

describe("EgWalker cachedSortedEvents", () => {
	it("should not duplicate events in cachedSortedEvents when applying localOp", () => {
		const doc = new Doc("replica-A");
		const map = doc.getMap();
		
		const initialLength = (doc.egWalker as unknown as { cachedSortedEvents: unknown[] }).cachedSortedEvents.length;
		
		// Perform local operation
		map.set("key", "value");
		
		const newLength = (doc.egWalker as unknown as { cachedSortedEvents: unknown[] }).cachedSortedEvents.length;
		
		// Should only increment by 1
		expect(newLength).toBe(initialLength + 1);
		
		// Let's add another one to be sure
		map.set("key2", "value2");
		const newerLength = (doc.egWalker as unknown as { cachedSortedEvents: unknown[] }).cachedSortedEvents.length;
		expect(newerLength).toBe(newLength + 1);
	});
});
