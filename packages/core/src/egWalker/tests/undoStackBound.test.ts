import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

/**
 * PLAN_13.2 — the engine's undo stack is a bounded cache used only to accelerate
 * the incremental suffix-rebuild. Capping it must (a) keep retained closures
 * within the limit for a long-lived client and (b) never change the converged
 * document state, because a missing undo transparently falls back to a full
 * rebuild from the sorted event list.
 */
describe("PLAN_13.2 — bounded undo stack with rebuild fallback", () => {
	it("keeps the undo stack within its cap over a long session", () => {
		const doc = new Doc("rep-cap");
		doc.egWalker.setUndoStackLimit(16);

		for (let i = 0; i < 500; i++) {
			doc.getMap().set(`k${i}`, i);
			expect(doc.egWalker.getUndoStackSize()).toBeLessThanOrEqual(16);
		}

		// All 500 keys are present even though only the last <=16 undo closures
		// are retained — undo closures are not needed to read current state.
		expect(doc.getMap().get("k0")).toBe(0);
		expect(doc.getMap().get("k499")).toBe(499);
		expect(doc.egWalker.getUndoStackSize()).toBeLessThanOrEqual(16);
	});

	it("converges under concurrency despite a tiny cap forcing rebuild fallbacks", () => {
		// A tiny cap guarantees the incremental undo path frequently cannot find
		// a needed undo, exercising the full-rebuild fallback in _ingestEvents.
		const a = new Doc("rep-a");
		const b = new Doc("rep-b");
		a.egWalker.setUndoStackLimit(4);
		b.egWalker.setUndoStackLimit(4);

		// A reference replica with the default (large) cap always uses the fast
		// incremental path; its final state is the correctness oracle.
		const ref = new Doc("rep-ref");

		let aVersion = a.egWalker.getVersion();
		let bVersion = b.egWalker.getVersion();

		const rounds = 200;
		for (let i = 0; i < rounds; i++) {
			a.getMap().set(`a${i}`, i);
			b.getMap().set(`b${i}`, i);

			const aNew: CrdtEvent[] = a.egWalker.graph.getChangesSince(aVersion);
			const bNew: CrdtEvent[] = b.egWalker.graph.getChangesSince(bVersion);

			b.egWalker.integrateRemote(aNew);
			a.egWalker.integrateRemote(bNew);
			ref.egWalker.integrateRemote([...aNew, ...bNew]);

			aVersion = a.egWalker.getVersion();
			bVersion = b.egWalker.getVersion();

			expect(a.egWalker.getUndoStackSize()).toBeLessThanOrEqual(4);
			expect(b.egWalker.getUndoStackSize()).toBeLessThanOrEqual(4);
		}

		// The capped replicas converge with each other and with the reference,
		// proving the rebuild fallback reconstructs identical state.
		expect(a.getMap().toJSON()).toEqual(b.getMap().toJSON());
		expect(a.getMap().toJSON()).toEqual(ref.getMap().toJSON());
	});

	it("setUndoStackLimit trims immediately and rejects invalid limits", () => {
		const doc = new Doc("rep-trim");
		for (let i = 0; i < 50; i++) {
			doc.getMap().set(`k${i}`, i);
		}
		expect(doc.egWalker.getUndoStackSize()).toBe(50);

		doc.egWalker.setUndoStackLimit(10);
		expect(doc.egWalker.getUndoStackSize()).toBe(10);

		expect(() => doc.egWalker.setUndoStackLimit(0)).toThrow();
		expect(() => doc.egWalker.setUndoStackLimit(-1)).toThrow();
		expect(() => doc.egWalker.setUndoStackLimit(1.5)).toThrow();
	});
});
