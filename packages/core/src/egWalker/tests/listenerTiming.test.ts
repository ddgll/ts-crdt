import { describe, it, expect, vi } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { EgWalkerError } from "../egWalker.js";

describe("EgWalker listener timing", () => {
	it("should fire integrateRemote listeners with consistent document state", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Set up initial shared state
		doc1.getMap().set("key1", "val1");
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// Register listener on doc2 that checks document state
		const statesSeen: unknown[] = [];
		doc2.egWalker.onEvent((_event, _isLocal) => {
			// When this fires, the document should already reflect the remote event
			statesSeen.push(doc2.getMap().get("key2"));
		});

		// Create a remote event on doc1
		doc1.getMap().set("key2", "val2");
		const newEvent = doc1.egWalker.graph.getAllEvents().pop()!;

		// Integrate the remote event into doc2
		doc2.egWalker.integrateRemote([newEvent]);

		// The listener should have seen "val2" (consistent state), not undefined (stale state)
		expect(statesSeen).toEqual(["val2"]);
	});

	it("should not break when a listener throws an error", () => {
		const doc = new Doc("replica1");

		const results: string[] = [];

		// First listener: throws
		doc.egWalker.onEvent(() => {
			throw new Error("Faulty listener");
		});

		// Second listener: should still fire
		doc.egWalker.onEvent((_event, _isLocal) => {
			results.push("second-listener-fired");
		});

		// Suppress console.error output during test
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// This should not throw
		expect(() => doc.getMap().set("key", "val")).not.toThrow();

		// The second listener should have been called despite the first one throwing
		expect(results).toEqual(["second-listener-fired"]);
		expect(consoleSpy).toHaveBeenCalledWith(
			"[EgWalker] Event listener error:",
			expect.any(Error),
		);

		consoleSpy.mockRestore();
	});
});

describe("EgWalker replicaId validation", () => {
	it("should reject replicaId containing a colon", () => {
		const doc = new Doc();
		expect(() => new (doc.egWalker.constructor as typeof import("../egWalker.js").EgWalker)(doc, "my:replica")).toThrow(
			new EgWalkerError("replicaId must not contain ':'"),
		);
	});

	it("should accept valid replicaId without colons", () => {
		const doc = new Doc("valid-replica-id");
		expect(doc.egWalker.getReplicaId()).toBe("valid-replica-id");
	});
});
