import { describe, it, expect } from "vitest";
import { EventGraph, CrdtEvent, MAP_SET_OP } from "../eventGraph.js";

/**
 * PLAN_05.2 — `getLastCriticalVersion` rewritten from per-candidate BFS (O(n^2))
 * to two linear frontier passes. These tests pin correctness on non-trivial DAG
 * shapes and guard against a quadratic-time regression on a large graph.
 */

function ev(id: string, parents: string[]): CrdtEvent {
	return { id, parents, replicaId: id.split(":")[0], op: { type: MAP_SET_OP, path: [], key: id, value: 1 } };
}

describe("PLAN_05.2 — linear getLastCriticalVersion", () => {
	it("returns the latest articulation point across repeated fork/merge", () => {
		const g = new EventGraph();
		// r -> (a, b) -> m(merge) -> c -> (d, e) two open heads
		g.addEvent(ev("r:1", []));
		g.addEvent(ev("a:2", ["r:1"]));
		g.addEvent(ev("b:3", ["r:1"]));
		g.addEvent(ev("m:4", ["a:2", "b:3"]));
		g.addEvent(ev("c:5", ["m:4"]));
		g.addEvent(ev("d:6", ["c:5"]));
		g.addEvent(ev("e:7", ["c:5"]));

		// c:5 is the last single-head point: everything before is its ancestor,
		// everything after (d, e) is its descendant.
		expect(g.getLastCriticalVersion()).toEqual(["c:5"]);
	});

	it("returns [] when the graph has disjoint roots (never necks to one head)", () => {
		const g = new EventGraph();
		g.addEvent(ev("a:1", []));
		g.addEvent(ev("b:1", []));
		expect(g.getLastCriticalVersion()).toEqual([]);
	});

	it("returns the single head for a linear chain", () => {
		const g = new EventGraph();
		g.addEvent(ev("a:1", []));
		g.addEvent(ev("b:2", ["a:1"]));
		g.addEvent(ev("c:3", ["b:2"]));
		expect(g.getLastCriticalVersion()).toEqual(["c:3"]);
	});

	it("does not treat a transiently-single head as critical when a later event branches earlier", () => {
		const g = new EventGraph();
		// root -> A ; root -> C (C branches from root, concurrent with A)
		g.addEvent(ev("root:1", []));
		g.addEvent(ev("A:2", ["root:1"]));
		g.addEvent(ev("C:3", ["root:1"]));
		// The only global articulation vertex is root:1, NOT A:2.
		expect(g.getLastCriticalVersion()).toEqual(["root:1"]);
	});

	it("computes the critical version on a large graph in sub-quadratic time", () => {
		const g = new EventGraph();
		const N = 4000;
		g.addEvent(ev("r:0", []));
		let prev = "r:0";
		for (let i = 1; i < N; i++) {
			const id = `r:${i}`;
			g.addEvent(ev(id, [prev]));
			prev = id;
		}
		// Fork two concurrent heads off the tail so the graph has >1 head (this
		// forces a full recompute rather than the single-head cache/early-return).
		g.addEvent(ev("x:" + (N + 1), [prev]));
		g.addEvent(ev("y:" + (N + 2), [prev]));

		const start = performance.now();
		const result = g.getLastCriticalVersion();
		const duration = performance.now() - start;

		// The node just before the fork is the last critical version.
		expect(result).toEqual([prev]);
		// A quadratic implementation on 4000 events would be far slower; this is a
		// generous ceiling that still fails an O(n^2) regression.
		expect(duration).toBeLessThan(200);
	});
});
