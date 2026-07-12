import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";

/**
 * Regression tests for PLAN_01: last-writer-wins must respect happened-before.
 *
 * The numeric part of an event id is a Lamport timestamp that advances on
 * observation of every event, so a causally-later write always outranks an
 * earlier one it descends from — regardless of how many events each replica
 * had produced independently.
 */
describe("Causal last-writer-wins (Lamport ordering)", () => {
	it("a causally-later write wins even though the writer produced fewer local ops", () => {
		const docA = new Doc("A");
		const docB = new Doc("B");

		// A performs 50 map writes to key "k" (and others), ending on "A-final".
		for (let i = 0; i < 49; i++) {
			docA.getMap().set(`filler${i}`, i);
		}
		docA.getMap().set("k", "A-wins-locally");

		// B starts fresh, observes all of A's history, then overwrites "k".
		// This is only B's *first* write, but it causally follows everything A did.
		docB.egWalker.integrateRemote(docA.egWalker.graph.getAllEvents());
		const bWrite = docB.getMap().set("k", "B-is-causally-later");

		// Under a plain per-replica counter, B's write would carry seq 0 and lose
		// to A's much larger seq. Under the Lamport clock, B's timestamp exceeds
		// A's, so B wins — and both replicas must agree.
		docA.egWalker.integrateRemote([bWrite]);

		expect(docB.getMap().get("k")).toBe("B-is-causally-later");
		expect(docA.getMap().get("k")).toBe("B-is-causally-later");
	});

	it("concurrent writes converge to the same deterministic winner on both replicas", () => {
		const docA = new Doc("A");
		const docB = new Doc("B");

		// Genuinely concurrent first writes to the same key — neither observed the
		// other. Both carry the same Lamport timestamp; the replicaId tiebreak
		// picks the winner deterministically ("B" > "A").
		const aWrite = docA.getMap().set("k", "from-A");
		const bWrite = docB.getMap().set("k", "from-B");

		docA.egWalker.integrateRemote([bWrite]);
		docB.egWalker.integrateRemote([aWrite]);

		expect(docA.getMap().get("k")).toBe(docB.getMap().get("k"));
		expect(docA.getMap().get("k")).toBe("from-B");
	});

	it("concurrent set vs delete on the same key converges on both replicas", () => {
		const docA = new Doc("A");
		const docB = new Doc("B");

		// Seed a shared value.
		const seed = docA.getMap().set("k", "seed");
		docB.egWalker.integrateRemote([seed]);

		// A overwrites, B deletes — concurrently (each only observed the seed).
		const aSet = docA.getMap().set("k", "A-updated");
		const bDel = docB.getMap().delete("k");

		docA.egWalker.integrateRemote([bDel]);
		docB.egWalker.integrateRemote([aSet]);

		// Both replicas must land on the same resolution.
		expect(docA.getMap().get("k")).toEqual(docB.getMap().get("k"));
	});

	it("a causal delete removes a value regardless of the setter's local op count", () => {
		const docA = new Doc("A");
		const docB = new Doc("B");

		for (let i = 0; i < 20; i++) {
			docA.getMap().set(`filler${i}`, i);
		}
		docA.getMap().set("k", "present");

		// B observes A's history, then deletes "k" — a causally-later op.
		docB.egWalker.integrateRemote(docA.egWalker.graph.getAllEvents());
		const bDel = docB.getMap().delete("k");
		docA.egWalker.integrateRemote([bDel]);

		expect(docB.getMap().get("k")).toBeUndefined();
		expect(docA.getMap().get("k")).toBeUndefined();
	});
});
