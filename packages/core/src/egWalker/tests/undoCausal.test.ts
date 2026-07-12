import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { UndoManager } from "../UndoManager.js";

/**
 * Tests for PLAN_04: UndoManager causal correctness.
 *
 * With the inverse-operation model, undoing a local change must remove exactly
 * that change even when remote events causally descend from it — the failure
 * mode of the old version-rewind implementation, which dragged undone local
 * events back in as ancestors of remote events.
 */
describe("UndoManager causal correctness (PLAN_04)", () => {
	it("removes an undone local insert even when a remote event descends from it", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc1.egWalker);

		// Local insert X.
		undoManager.track();
		doc1.getMap().getArray("arr").insert(0, ["X"]);
		undoManager.track();

		// Remote insert Y that causally follows X (Y's parent is X).
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
		doc2.getMap().getArray("arr").insert(1, ["Y"]);
		const remoteEvents = doc2.egWalker.graph.getChangesSince(
			doc1.egWalker.getVersion(),
		);
		doc1.egWalker.integrateRemote(remoteEvents);

		expect(doc1.getMap().getArray("arr").toJSON()).toEqual(["X", "Y"]);

		// Undo the local insert of X. X must be gone; Y (which descends from X)
		// must survive.
		undoManager.undo();

		expect(doc1.getMap().getArray("arr").toJSON()).toEqual(["Y"]);
	});

	it("removes an undone local map-set even when a remote set descends from it", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc1.egWalker);

		undoManager.track();
		doc1.getMap().set("x", "local");
		undoManager.track();

		// Remote event whose parent is the local set.
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
		doc2.getMap().set("y", "remote");
		const remoteEvents = doc2.egWalker.graph.getChangesSince(
			doc1.egWalker.getVersion(),
		);
		doc1.egWalker.integrateRemote(remoteEvents);

		undoManager.undo();

		expect(doc1.getMap().get("x")).toBeUndefined();
		expect(doc1.getMap().get("y")).toBe("remote");
	});

	it("propagates undo to other replicas as a new event", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc1.egWalker);

		undoManager.track();
		doc1.getMap().set("k", "v");
		undoManager.track();

		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
		expect(doc2.getMap().get("k")).toBe("v");

		// Undo emits an inverse event; replicating it must clear the value on doc2.
		undoManager.undo();
		const undoEvents = doc1.egWalker.graph.getChangesSince(
			doc2.egWalker.getVersion(),
		);
		doc2.egWalker.integrateRemote(undoEvents);

		expect(doc1.getMap().get("k")).toBeUndefined();
		expect(doc2.getMap().get("k")).toBeUndefined();
	});

	it("supports redo after remote edits interleave", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc1.egWalker);

		undoManager.track();
		doc1.getMap().set("k", "v1");
		undoManager.track();

		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());
		doc2.getMap().set("remote", "r");
		doc1.egWalker.integrateRemote(
			doc2.egWalker.graph.getChangesSince(doc1.egWalker.getVersion()),
		);

		undoManager.undo();
		expect(doc1.getMap().get("k")).toBeUndefined();
		expect(doc1.getMap().get("remote")).toBe("r");

		undoManager.redo();
		expect(doc1.getMap().get("k")).toBe("v1");
		expect(doc1.getMap().get("remote")).toBe("r");
	});

	it("undoes and redoes a nested-container operation", () => {
		const doc = new Doc("replica1");
		const undoManager = new UndoManager(doc.egWalker);

		const inner = doc.getMap().getMap("inner");
		undoManager.track();
		inner.set("field", "value");
		undoManager.track();

		expect(doc.getMap().getMap("inner").get("field")).toBe("value");

		undoManager.undo();
		expect(doc.getMap().getMap("inner").get("field")).toBeUndefined();

		undoManager.redo();
		expect(doc.getMap().getMap("inner").get("field")).toBe("value");
	});

	it("undoes a text delete by reviving the content", () => {
		const doc = new Doc("replica1");
		const undoManager = new UndoManager(doc.egWalker);

		const text = doc.getMap().getText("t");
		text.insert(0, "hello world");
		undoManager.track();

		text.delete(5, 6); // remove " world"
		expect(text.toString()).toBe("hello");
		undoManager.track();

		undoManager.undo();
		expect(doc.getMap().getText("t").toString()).toBe("hello world");
	});

	it("keeps repeated undo/redo consistent under concurrent remote edits", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");
		const undoManager = new UndoManager(doc1.egWalker);

		undoManager.track();
		doc1.getMap().set("a", 1);
		undoManager.track();
		doc1.getMap().set("b", 2);
		undoManager.track();

		// Concurrent remote edit.
		doc2.getMap().set("c", 3);
		doc1.egWalker.integrateRemote(
			doc2.egWalker.graph.getChangesSince(doc1.egWalker.getVersion()),
		);

		undoManager.undo(); // b
		undoManager.undo(); // a
		expect(doc1.getMap().get("a")).toBeUndefined();
		expect(doc1.getMap().get("b")).toBeUndefined();
		expect(doc1.getMap().get("c")).toBe(3);

		undoManager.redo(); // a
		undoManager.redo(); // b
		expect(doc1.getMap().get("a")).toBe(1);
		expect(doc1.getMap().get("b")).toBe(2);
		expect(doc1.getMap().get("c")).toBe(3);
	});
});
