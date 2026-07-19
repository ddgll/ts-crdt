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

	// B5: a group whose ops all have null inverses (formatting, container
	// overwrite/delete) must still record an undo boundary, so undo() consumes
	// that boundary as a no-op instead of reaching back and reverting an OLDER
	// group's state destructively.
	describe("non-invertible group boundaries (B5)", () => {
		it("undoing a format-only group leaves the underlying text intact", () => {
			const doc = new Doc("r1");
			const text = doc.getMap().getText("t");
			const undo = new UndoManager(doc.egWalker);

			text.insert(0, "hello");
			undo.track();
			text.format(0, 5, { bold: true });
			undo.track();

			undo.undo(); // undoing the format group must NOT delete "hello"
			expect(text.toString()).toBe("hello");

			undo.undo(); // now the insert group is undone
			expect(text.toString()).toBe("");

			undo.redo();
			expect(text.toString()).toBe("hello");
		});

		it("undoing a container-overwrite group is a no-op, not corruption", () => {
			const doc = new Doc("r1");
			const map = doc.getMap();
			const undo = new UndoManager(doc.egWalker);

			map.getMap("nest").set("a", 1);
			undo.track();
			map.set("nest", "overwritten");
			undo.track();

			undo.undo();
			// Pre-fix this reverted an OLDER group and produced { nest: {} }; now it
			// consumes the non-invertible boundary and leaves state unchanged.
			expect(map.get("nest")).toBe("overwritten");
		});

		it("a track() with no intervening op stays a true no-op", () => {
			const doc = new Doc("r1");
			const arr = doc.getMap().getArray("arr");
			const undo = new UndoManager(doc.egWalker);

			arr.insert(0, ["x"]);
			undo.track();
			undo.track(); // spurious
			undo.track(); // spurious

			undo.undo(); // must still undo the real insert
			expect(arr.toJSON()).toEqual([]);
		});
	});
});
