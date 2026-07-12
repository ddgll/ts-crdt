import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { UndoManager } from "../UndoManager.js";

describe("Undo Edge Cases", () => {
	it("should undo local actions even if interleaved with remote edits", () => {
		const doc1 = new Doc("replica1");
		const undoManager = new UndoManager(doc1.egWalker);
		const map1 = doc1.getMap();
		undoManager.track();

		// User A (doc1) performs 5 actions
		map1.set("key1", "val1_a");
		map1.set("key2", "val2_a");
		undoManager.track();
		
		map1.set("key3", "val3_a");
		undoManager.track();

		// User B (doc2) performs concurrent actions
		const doc2 = new Doc("replica2");
		const map2 = doc2.getMap();
		map2.set("key4", "val4_b");
		map2.set("key5", "val5_b");
		
		// Sync both
		const events1 = doc1.egWalker.getStateSnapshot().graph.events.map(e => e[1]);
		const events2 = doc2.egWalker.getStateSnapshot().graph.events.map(e => e[1]);
		
		doc1.egWalker.integrateRemote(events2);
		doc2.egWalker.integrateRemote(events1);
		
		// Doc1 should have all 5 keys
		expect(map1.get("key1")).toBe("val1_a");
		expect(map1.get("key4")).toBe("val4_b");
		
		// Doc1 undoes last action
		undoManager.undo();
		
		// "key3" was undone by user A, "key4" by user B should remain
		expect(doc1.getMap().get("key3")).toBeUndefined();
		expect(doc1.getMap().get("key1")).toBe("val1_a");
		expect(doc1.getMap().get("key4")).toBe("val4_b"); // User B's edit is untouched
	});
});
