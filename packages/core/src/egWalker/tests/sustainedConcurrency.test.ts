import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

/**
 * PLAN_05.1 — sustained concurrent remote integration should stay well under
 * quadratic cost: the EgWalker fast undo/redo path bounds work to the reordered
 * suffix rather than replaying the whole document per out-of-order event. This
 * test interleaves edits from two replicas, exchanging only the newly-created
 * events each round, and asserts it both converges and completes quickly.
 */
describe("PLAN_05.1 — sustained concurrent integration is sub-quadratic", () => {
	it("interleaved two-replica exchange stays fast and converges", () => {
		const a = new Doc("rep-a");
		const b = new Doc("rep-b");
		a.getMap().getArray("v").insert(0, []);
		b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

		const rounds = 400;
		let aVersion = a.egWalker.getVersion();
		let bVersion = b.egWalker.getVersion();

		const start = performance.now();
		for (let i = 0; i < rounds; i++) {
			a.getMap().set(`a${i}`, i);
			b.getMap().set(`b${i}`, i);

			const aNew: CrdtEvent[] = a.egWalker.graph.getChangesSince(aVersion);
			const bNew: CrdtEvent[] = b.egWalker.graph.getChangesSince(bVersion);

			b.egWalker.integrateRemote(aNew);
			a.egWalker.integrateRemote(bNew);

			aVersion = a.egWalker.getVersion();
			bVersion = b.egWalker.getVersion();
		}
		const duration = performance.now() - start;

		// Both replicas converge on identical state.
		expect(a.getMap().toJSON()).toEqual(b.getMap().toJSON());
		// 400 rounds = 800 interleaved integrations. A full-rebuild-per-event
		// (quadratic) implementation would be dramatically slower; this ceiling is
		// generous but still catches a quadratic regression.
		expect(duration).toBeLessThan(2000);
	});
});
