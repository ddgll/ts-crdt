import { Doc } from "../doc.js";
import { YMap } from "../yMap.js";
import { YArray } from "../yArray.js";
import { YText } from "../yText.js";
import { describe, it, expect } from "vitest";

describe("Nested CRDT Structures", () => {
	it("should correctly serialize and deserialize deeply nested structures", () => {
		const doc1 = new Doc("replica1");
		const rootMap = doc1.getMap();

		// Level 1: Map -> Map
		const level1 = rootMap.getMap("level1");
		level1.set("key", "val");
		
		// Level 2: Map -> Text
		const text = level1.getText("text1");
		text.insert(0, "hello");

		// Level 3: Map -> Map
		const level2 = level1.getMap("level2");
		level2.set("deepKey", "deepVal");

		// Get all events and snapshot
		const events = doc1.egWalker.getStateSnapshot().graph.events.map(e => e[1]);
		const doc2 = new Doc("replica2");
		
		// Apply all events to doc2
		doc2.egWalker.integrateRemote(events);
		
		// Assert structures matched
		const rootMap2 = doc2.getMap();
		const l1 = rootMap2.getMap("level1");
		expect(l1.get("key")).toBe("val");

		const t1 = l1.getText("text1");
		expect(t1.toString()).toBe("hello");

		const l2 = l1.getMap("level2");
		expect(l2.get("deepKey")).toBe("deepVal");

		// Test snapshotting
		const snapshot = doc1.egWalker.getStateSnapshot();
		const doc3 = new Doc("replica3");
		doc3.egWalker.loadStateSnapshot(snapshot);

		const rootMap3 = doc3.getMap();
		const l1_3 = rootMap3.getMap("level1");
		expect(l1_3.get("key")).toBe("val");

		const t1_3 = l1_3.getText("text1");
		expect(t1_3.toString()).toBe("hello");

		const l2_3 = l1_3.getMap("level2");
		expect(l2_3.get("deepKey")).toBe("deepVal");
	});
});
