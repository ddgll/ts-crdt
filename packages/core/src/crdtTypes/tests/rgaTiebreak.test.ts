import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";
import { rgaInsertIndex, baseEventId } from "../rga.js";

type Item = { id: string; originId: string | null; rightOriginId: string | null };
const item = (id: string, originId: string | null = null, rightOriginId: string | null = null): Item => ({ id, originId, rightOriginId });
const index = (data: Item[]) => new Map(data.map((it, i) => [it.id, i]));

/**
 * These tests pin the YATA/right-origin integration that YArray and YText share
 * via {@link rgaInsertIndex}. The convention is:
 *
 *   A new run is bounded on the left by its origin (`afterId`) and on the right
 *   by its right origin (`beforeId`). Among elements that share the same left
 *   origin (genuine concurrents), a new insert is placed AFTER every element
 *   whose base event id is strictly smaller, and BEFORE the first element whose
 *   base event id is >= the inserting event id.
 *
 * Because `compareEventIds` orders by Lamport timestamp first then replicaId,
 * concurrent inserts sharing an anchor (equal timestamps) settle into ascending
 * replicaId order, and interior inserts are pinned to the gap between their two
 * origins instead of walking to the end.
 */
describe("RGA tie-break convention", () => {
	describe("rgaInsertIndex helper", () => {
		it("returns 0 for a head insert bounded by the first element", () => {
			const data = [item("a:1:0"), item("a:2:0", "a:1:0")];
			expect(rgaInsertIndex(data, index(data), null, "a:1:0", "b:5")).toBe(0);
		});

		it("pins an interior insert to the gap between its two origins", () => {
			// "ab": inserting X between a and b (origin a, right origin b) lands at
			// index 1 rather than walking to the end.
			const data = [item("r:0:0"), item("r:1:0", "r:0:0")];
			expect(rgaInsertIndex(data, index(data), "r:0:0", "r:1:0", "r:2")).toBe(1);
		});

		it("falls back to the head when the origin is not present", () => {
			// Only reachable when an anchor was gc'd without a synchronising
			// snapshot; the result must at least be deterministic.
			const data = [item("a:1:0")];
			expect(rgaInsertIndex(data, index(data), "missing:9:0", null, "b:5")).toBe(0);
		});

		it("places a lower-id insert after a higher-id sibling of the same anchor", () => {
			// Anchor A (a:1:0). Sibling B (b:2:0, origin A) already follows it.
			// Inserting C (c:2 — equal timestamp, 'c' > 'b') goes AFTER B.
			const data = [item("a:1:0"), item("b:2:0", "a:1:0")];
			expect(rgaInsertIndex(data, index(data), "a:1:0", null, "c:2")).toBe(2);
		});

		it("places a lower replicaId insert before an already-present higher one", () => {
			// Sibling C (c:2:0, origin A). Inserting B (b:2 — same timestamp,
			// 'b' < 'c') must land BEFORE C, i.e. right after the anchor.
			const data = [item("a:1:0"), item("c:2:0", "a:1:0")];
			expect(rgaInsertIndex(data, index(data), "a:1:0", null, "b:2")).toBe(1);
		});

		it("orders by Lamport timestamp ahead of replicaId", () => {
			// Sibling z:1:0 (origin anchor) has a smaller timestamp than the
			// inserting a:2, so the new insert goes after it even though 'a' < 'z'.
			const data = [item("anchor:0:0"), item("z:1:0", "anchor:0:0")];
			expect(rgaInsertIndex(data, index(data), "anchor:0:0", null, "a:2")).toBe(2);
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
