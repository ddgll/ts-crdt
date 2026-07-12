import { describe, it, expect } from "vitest";
import { EventGraph, CrdtEvent, MAP_SET_OP } from "../eventGraph.js";

function ev(id: string, parents: string[]): CrdtEvent {
	return { id, parents, replicaId: id.split(":")[0], op: { type: MAP_SET_OP, path: [], key: id, value: 1 } };
}

/**
 * PLAN_05.4 — `getSortedEvents()` returns the graph's internal array by
 * reference (a documented, performance-motivated borrowed view). These tests pin
 * that contract and verify the safe alternative does not alias.
 */
describe("PLAN_05.4 — sorted events aliasing contract", () => {
	it("getSortedEvents returns a live borrowed view that reflects later addEvent", () => {
		const g = new EventGraph();
		g.addEvent(ev("a:1", []));
		const borrowed = g.getSortedEvents();
		expect(borrowed.length).toBe(1);

		// A subsequent append mutates the same array the caller is holding.
		g.addEvent(ev("b:2", ["a:1"]));
		expect(borrowed.length).toBe(2);
		expect(borrowed).toBe(g.getSortedEvents());
	});

	it("getSortedEventsCopy returns an owned snapshot that does NOT alias", () => {
		const g = new EventGraph();
		g.addEvent(ev("a:1", []));
		const copy = g.getSortedEventsCopy();
		expect(copy.length).toBe(1);

		g.addEvent(ev("b:2", ["a:1"]));
		// The copy is frozen at the moment it was taken.
		expect(copy.length).toBe(1);
		expect(copy).not.toBe(g.getSortedEvents());
	});
});
