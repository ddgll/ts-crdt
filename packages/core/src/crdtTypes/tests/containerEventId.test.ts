import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

/**
 * Tests for PLAN_06: container creation without an event id.
 *
 * A nested container created via getMap/getArray/getText carries no event id
 * until an operation writes into it. These tests assert that once a container
 * is written to, concurrent conflicts against it resolve deterministically and
 * identically on every replica — regardless of whether the container was created
 * locally (undefined id) or lazily materialized by a remote op.
 */
describe("Container creation event id (PLAN_06)", () => {
	/** Fully cross-integrates two docs until they converge. */
	function sync(a: Doc, b: Doc) {
		const eventsA = a.egWalker.graph.getAllEvents();
		const eventsB = b.egWalker.graph.getAllEvents();
		a.egWalker.integrateRemote(eventsB);
		b.egWalker.integrateRemote(eventsA);
	}

	it("gives a written container the same LWW id on origin and remote replicas", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// doc1 creates a container locally (no event) then writes a child.
		doc1.getMap().getMap("box").set("child", 1);

		const events = doc1.egWalker.graph.getAllEvents();
		doc2.egWalker.integrateRemote(events);

		const id1 = doc1.getMap()._getWrapper("box")?.eventId;
		const id2 = doc2.getMap()._getWrapper("box")?.eventId;

		// The origin no longer leaves the container with an undefined id...
		expect(id1).toBeDefined();
		// ...and it matches the id the remote assigned when materializing it lazily.
		expect(id1).toBe(id2);
	});

	it("resolves concurrent container-vs-primitive deterministically on both replicas", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Concurrent: doc1 populates a nested map at "x"; doc2 sets "x" to a primitive.
		doc1.getMap().getMap("x").set("a", "fromContainer");
		doc2.getMap().set("x", "fromPrimitive");

		sync(doc1, doc2);

		// Both replicas must agree on the winner (no divergence).
		expect(doc1.getMap().toJSON()).toEqual(doc2.getMap().toJSON());
		expect(doc1.getMap()._getWrapper("x")?.eventId).toBe(
			doc2.getMap()._getWrapper("x")?.eventId,
		);
	});

	it("does not silently lose a populated container to a concurrent primitive on either replica", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		doc1.getMap().getMap("x").set("a", 1);
		doc2.getMap().set("x", 42);

		sync(doc1, doc2);

		// Whichever side wins, both replicas reach the *same* outcome.
		const j1 = doc1.getMap().toJSON();
		const j2 = doc2.getMap().toJSON();
		expect(j1).toEqual(j2);
	});

	it("merges concurrent writes into containers created independently on each replica", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Each replica independently creates the same-keyed container and writes a
		// distinct child key.
		doc1.getMap().getMap("shared").set("fromA", "a");
		doc2.getMap().getMap("shared").set("fromB", "b");

		sync(doc1, doc2);

		// Children merge and both replicas converge to the same value and id.
		expect(doc1.getMap().toJSON()).toEqual(doc2.getMap().toJSON());
		const shared1 = doc1.getMap().getMap("shared");
		expect(shared1.get("fromA")).toBe("a");
		expect(shared1.get("fromB")).toBe("b");
		expect(doc1.getMap()._getWrapper("shared")?.eventId).toBe(
			doc2.getMap()._getWrapper("shared")?.eventId,
		);
	});

	it("converges the container id regardless of the order remote events are integrated", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		doc1.getMap().getMap("g").set("fromA", "a");
		doc2.getMap().getMap("g").set("fromB", "b");

		const eventsA = doc1.egWalker.graph.getAllEvents();
		const eventsB = doc2.egWalker.graph.getAllEvents();

		// Integrate in opposite relative orders on a fresh pair of replicas.
		const doc3 = new Doc("replica3");
		const doc4 = new Doc("replica4");
		doc3.egWalker.integrateRemote(eventsA as CrdtEvent[]);
		doc3.egWalker.integrateRemote(eventsB as CrdtEvent[]);
		doc4.egWalker.integrateRemote(eventsB as CrdtEvent[]);
		doc4.egWalker.integrateRemote(eventsA as CrdtEvent[]);

		expect(doc3.getMap().toJSON()).toEqual(doc4.getMap().toJSON());
		expect(doc3.getMap()._getWrapper("g")?.eventId).toBe(
			doc4.getMap()._getWrapper("g")?.eventId,
		);
	});
});
