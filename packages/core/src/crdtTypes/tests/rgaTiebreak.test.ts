import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";
import { rgaInsertIndex, baseEventId } from "../rga.js";

/**
 * These tests pin the RGA tie-break convention that YArray and YText share via
 * {@link rgaInsertIndex} (see PLAN_02). The convention is:
 *
 *   Among elements following the same anchor, a new insert is placed AFTER every
 *   element whose base event id is strictly smaller, and BEFORE the first element
 *   whose base event id is >= the inserting event id.
 *
 * Because `compareEventIds` orders by Lamport timestamp first then replicaId,
 * concurrent inserts sharing an anchor (equal timestamps) settle into ascending
 * replicaId order.
 */
describe("RGA tie-break convention", () => {
	describe("rgaInsertIndex helper", () => {
		it("returns 0 when there is no anchor (head insert)", () => {
			const data = [{ id: "a:1:0" }, { id: "a:2:0" }];
			const idIndex = new Map(data.map((it, i) => [it.id, i]));
			expect(rgaInsertIndex(data, idIndex, null, "b:5")).toBe(0);
		});

		it("appends when the anchor is not present", () => {
			const data = [{ id: "a:1:0" }];
			const idIndex = new Map(data.map((it, i) => [it.id, i]));
			expect(rgaInsertIndex(data, idIndex, "missing:9:0", "b:5")).toBe(1);
		});

		it("places a lower-id insert before a higher-id sibling of the same anchor", () => {
			// Anchor is A (a:1:0). Sibling B (b:2:0) already follows it. Inserting
			// C (c:2 — equal timestamp, replicaId 'c' > 'b') should go AFTER B.
			const data = [{ id: "a:1:0" }, { id: "b:2:0" }];
			const idIndex = new Map(data.map((it, i) => [it.id, i]));
			expect(rgaInsertIndex(data, idIndex, "a:1:0", "c:2")).toBe(2);
		});

		it("places a lower replicaId insert before an already-present higher one", () => {
			// Sibling is C (c:2:0). Inserting B (b:2 — same timestamp, 'b' < 'c')
			// must land BEFORE C, i.e. right after the anchor.
			const data = [{ id: "a:1:0" }, { id: "c:2:0" }];
			const idIndex = new Map(data.map((it, i) => [it.id, i]));
			expect(rgaInsertIndex(data, idIndex, "a:1:0", "b:2")).toBe(1);
		});

		it("orders by Lamport timestamp ahead of replicaId", () => {
			// Sibling z:1:0 has a smaller timestamp than the inserting a:2, so the
			// new insert goes after it even though 'a' < 'z'.
			const data = [{ id: "anchor:0:0" }, { id: "z:1:0" }];
			const idIndex = new Map(data.map((it, i) => [it.id, i]));
			expect(rgaInsertIndex(data, idIndex, "anchor:0:0", "a:2")).toBe(2);
		});
	});

	it("baseEventId strips the run offset", () => {
		expect(baseEventId("replica:7:3")).toBe("replica:7");
	});

	it("pins the interleaving of two concurrent YArray inserts after the same anchor", () => {
		const a = new Doc("replicaA");
		const b = new Doc("replicaB");

		a.getMap().getArray("arr").insert(0, ["Anchor"]);
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

		// Genuinely concurrent: each replica only saw "Anchor" (Lamport 0) before
		// inserting, so both inserts carry Lamport timestamp 1 and are tie-broken
		// by replicaId ascending -> replicaA first.
		a.getMap().getArray("arr").insert(1, ["FromA"]);
		b.getMap().getArray("arr").insert(1, ["FromB"]);

		const aInsert = a.egWalker.graph
			.getAllEvents()
			.find((e) => e.op.type === "array-insert" && (e.op as { values: unknown[] }).values[0] === "FromA")!;
		const bInsert = b.egWalker.graph
			.getAllEvents()
			.find((e) => e.op.type === "array-insert" && (e.op as { values: unknown[] }).values[0] === "FromB")!;

		a.egWalker.integrateRemote([bInsert]);
		b.egWalker.integrateRemote([aInsert]);

		expect(a.getMap().getArray("arr").toJSON()).toEqual(["Anchor", "FromA", "FromB"]);
		expect(b.getMap().getArray("arr").toJSON()).toEqual(["Anchor", "FromA", "FromB"]);
	});

	it("pins the interleaving of two concurrent YText inserts after the same anchor", () => {
		const a = new Doc("replicaA");
		const b = new Doc("replicaB");

		a.getMap().getText("txt").insert(0, "X");
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

		a.getMap().getText("txt").insert(1, "A");
		b.getMap().getText("txt").insert(1, "B");

		const aInsert = a.egWalker.graph
			.getAllEvents()
			.find((e) => e.op.type === "text-insert" && (e.op as { text: string }).text === "A")!;
		const bInsert = b.egWalker.graph
			.getAllEvents()
			.find((e) => e.op.type === "text-insert" && (e.op as { text: string }).text === "B")!;

		a.egWalker.integrateRemote([bInsert]);
		b.egWalker.integrateRemote([aInsert]);

		// replicaA ('A') tie-breaks ahead of replicaB ('B').
		expect(a.getMap().getText("txt").toString()).toBe("XAB");
		expect(b.getMap().getText("txt").toString()).toBe("XAB");
	});

	it("pins the interleaving of three concurrent inserts after the same anchor", () => {
		const a = new Doc("rA");
		const b = new Doc("rB");
		const c = new Doc("rC");

		a.getMap().getArray("arr").insert(0, ["Anchor"]);
		const base = a.egWalker.graph.getAllEvents();
		b.egWalker.integrateRemote(base);
		c.egWalker.integrateRemote(base);

		// Three genuinely concurrent inserts after the same anchor.
		a.getMap().getArray("arr").insert(1, ["fromA"]);
		b.getMap().getArray("arr").insert(1, ["fromB"]);
		c.getMap().getArray("arr").insert(1, ["fromC"]);

		const pick = (doc: Doc, value: string) =>
			doc.egWalker.graph
				.getAllEvents()
				.find((e) => e.op.type === "array-insert" && (e.op as { values: unknown[] }).values[0] === value)!;

		const evA = pick(a, "fromA");
		const evB = pick(b, "fromB");
		const evC = pick(c, "fromC");

		// Deliver in different orders to each replica to prove order-independence.
		a.egWalker.integrateRemote([evC, evB]);
		b.egWalker.integrateRemote([evA, evC]);
		c.egWalker.integrateRemote([evB, evA]);

		// Equal Lamport timestamps -> ascending replicaId: rA, rB, rC.
		const expected = ["Anchor", "fromA", "fromB", "fromC"];
		expect(a.getMap().getArray("arr").toJSON()).toEqual(expected);
		expect(b.getMap().getArray("arr").toJSON()).toEqual(expected);
		expect(c.getMap().getArray("arr").toJSON()).toEqual(expected);
	});
});
