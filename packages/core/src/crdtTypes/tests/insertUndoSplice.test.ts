import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";

/**
 * PLAN_05.3 — the array/text insert undo was rewritten from an
 * `Array.includes` filter + full `_idIndex` rebuild to an exact
 * `splice(insertIdx, count)` that only re-indexes the shifted suffix. The
 * undo path runs on every fast-path re-integration, so these tests exercise
 * reordering (which triggers undo/redo) and then perform index-dependent
 * operations that would break if `_idIndex` were left inconsistent.
 */
describe("PLAN_05.3 — insert undo via span splice", () => {
	it("YArray converges and keeps a consistent index after reordered integration", () => {
		const a = new Doc("replica-a");
		const b = new Doc("replica-b");
		a.getMap().getArray("list").insert(0, []);
		// Sync the seed so both share the container.
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

		// Concurrent inserts at the head from both replicas.
		a.getMap().getArray("list").insert(0, ["a1", "a2"]);
		b.getMap().getArray("list").insert(0, ["b1", "b2"]);

		const aEvents = a.egWalker.graph.getAllEvents();
		const bEvents = b.egWalker.graph.getAllEvents();

		// Cross-integrate (each side sees the other's concurrent insert, forcing
		// undo/redo of the local tail during integration).
		a.egWalker.integrateRemote(bEvents);
		b.egWalker.integrateRemote(aEvents);

		const arrA = a.getMap().getArray("list");
		const arrB = b.getMap().getArray("list");
		expect(arrA.toJSON()).toEqual(arrB.toJSON());
		expect(arrA.length).toBe(4);

		// A further index-dependent op after the reorder: it must apply and still
		// converge, which relies on _idIndex being accurate post-undo/redo. (Exact
		// placement is governed by the RGA tie-break, so we assert convergence and
		// membership rather than a specific index.)
		const mid = Math.floor(arrA.length / 2);
		arrA.insert(mid, ["mid"]);
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());
		expect(arrB.toJSON()).toEqual(arrA.toJSON());
		expect(arrA.length).toBe(5);
		expect(arrA.toJSON()).toContain("mid");
	});

	it("YText converges and keeps a consistent index after reordered integration", () => {
		const a = new Doc("replica-a");
		const b = new Doc("replica-b");
		a.getMap().getText("doc").insert(0, "");
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

		a.getMap().getText("doc").insert(0, "AAA");
		b.getMap().getText("doc").insert(0, "BBB");

		const aEvents = a.egWalker.graph.getAllEvents();
		const bEvents = b.egWalker.graph.getAllEvents();
		a.egWalker.integrateRemote(bEvents);
		b.egWalker.integrateRemote(aEvents);

		const txtA = a.getMap().getText("doc");
		const txtB = b.getMap().getText("doc");
		expect(txtA.toString()).toBe(txtB.toString());
		expect(txtA.toString().length).toBe(6);

		// A further edit at a computed index must apply and still converge.
		txtA.insert(3, "X");
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());
		expect(txtB.toString()).toBe(txtA.toString());
		expect(txtA.toString().length).toBe(7);
		expect(txtA.toString()).toContain("X");
	});

	it("undo/redo through many reorderings preserves length and content", () => {
		const docs = [new Doc("r-a"), new Doc("r-b"), new Doc("r-c")];
		docs[0].getMap().getArray("l").insert(0, []);
		const seed = docs[0].egWalker.graph.getAllEvents();
		docs[1].egWalker.integrateRemote(seed);
		docs[2].egWalker.integrateRemote(seed);

		// Each replica performs several local inserts before any sync.
		for (let i = 0; i < 5; i++) {
			docs[0].getMap().getArray("l").insert(0, [`a${i}`]);
			docs[1].getMap().getArray("l").insert(0, [`b${i}`]);
			docs[2].getMap().getArray("l").insert(0, [`c${i}`]);
		}

		// Integrate everything everywhere, in mixed order.
		const all = docs.flatMap((d) => d.egWalker.graph.getAllEvents());
		for (const d of docs) {
			d.egWalker.integrateRemote(all);
		}

		const json0 = docs[0].getMap().getArray("l").toJSON();
		expect(docs[1].getMap().getArray("l").toJSON()).toEqual(json0);
		expect(docs[2].getMap().getArray("l").toJSON()).toEqual(json0);
		expect(docs[0].getMap().getArray("l").length).toBe(15);
	});
});
