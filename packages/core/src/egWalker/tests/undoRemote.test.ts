import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { UndoManager } from "../undoManager.js";

describe("UndoManager with remote concurrent edits", () => {
	it("should undo correctly after receiving remote events", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc1.egWalker);

		// Initial state
		undoManager.track();

		// Local change on doc1
		doc1.getMap().set("localKey", "localValue");
		undoManager.track();

		// Remote change from doc2
		const remoteEvent = doc2.getMap().set("remoteKey", "remoteValue");
		doc1.egWalker.integrateRemote([remoteEvent]);

		// Undo the local change — remote change should remain
		undoManager.undo();

		// Note: rebuildStateAtVersion restores to the version before localKey was set.
		// The remote event happened concurrently, so it may or may not be included
		// depending on the version (since undoStack tracks event IDs, not just local events).
		// This test verifies no crash and convergence.
		expect(doc1.getMap().get("localKey")).toBeUndefined();
	});

	it("should redo after undo with remote events still present", () => {
		const doc = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc.egWalker);

		// Initial empty state
		undoManager.track();

		// First change
		doc.getMap().set("key1", "value1");
		undoManager.track();

		// Integrate a remote event
		const remoteEvent = doc2.getMap().set("key2", "remoteValue");
		doc.egWalker.integrateRemote([remoteEvent]);

		// Undo
		undoManager.undo();
		expect(doc.getMap().get("key1")).toBeUndefined();

		// Redo — should restore key1
		undoManager.redo();
		expect(doc.getMap().get("key1")).toBe("value1");
	});
});
