import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtServer, Repository } from "../crdtServer.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

function makeRepo() {
	let saved: CrdtEvent[] = [];
	const repo: Repository = {
		getEvents: async () => saved,
		saveEvents: async (events) => { saved.push(...events); },
		clearEvents: async () => { saved = []; },
	};
	return repo;
}

/**
 * Recursively walks a state snapshot collecting every RGA item id it contains,
 * so tests can assert whether an insert anchor still resolves after gc.
 */
function collectItemIds(node: unknown): Set<string> {
	const ids = new Set<string>();
	const visit = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const el of value) visit(el);
			return;
		}
		if (value && typeof value === "object") {
			const rec = value as Record<string, unknown>;
			if (typeof rec.id === "string") ids.add(rec.id);
			for (const key of Object.keys(rec)) visit(rec[key]);
		}
	};
	visit(node);
	return ids;
}

/**
 * Builds the PLAN_10 stress scenario and returns the pieces needed to drive both
 * a compacted server and a non-compacted reference.
 *
 * Shape (content starts as [A, X, B]):
 *   - branch `del`: deletes X (authored while X is visible)
 *   - branch `ins`: inserts P *after X* (authored while X is visible, so its op
 *     anchors afterId = X's item id)
 *   - `merge`: integrates both branches then inserts M — a single articulation
 *     point whose ancestor set includes delete-X, so X is a tombstone at the
 *     critical version and gets gc'd out of the snapshot
 *   - `rA`, `rB`: two concurrent inserts AFTER the merge, so the critical version
 *     settles on the merge event and genuine remaining events exist
 */
async function buildScenario(roomId: string) {
	const server = new CrdtServer(roomId, makeRepo());
	await server.initialize();

	const c1 = new Doc("c1");
	c1.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
	c1.getMap().getArray("content").insert(0, ["A", "X", "B"]);
	server.getDoc().egWalker.integrateRemote(c1.egWalker.graph.getAllEvents());
	const baseEvents = server.getDoc().egWalker.graph.getAllEvents();

	const del = new Doc("del");
	del.egWalker.integrateRemote(baseEvents);
	const delBase = del.egWalker.getVersion();
	del.getMap().getArray("content").delete(1, 1);
	const delNew = del.egWalker.graph.getChangesSince(delBase);

	const ins = new Doc("ins");
	ins.egWalker.integrateRemote(baseEvents);
	const insBase = ins.egWalker.getVersion();
	ins.getMap().getArray("content").insert(2, ["P"]); // index 2 → afterId = X
	const insNew = ins.egWalker.graph.getChangesSince(insBase);

	// The id X is anchored to (its item id), so tests can check gc removed it.
	const insertAfterId =
		insNew[0]?.op.type === "array-insert" ? insNew[0].op.afterId : null;

	const merge = new Doc("merge");
	merge.egWalker.integrateRemote([...baseEvents, ...delNew, ...insNew]);
	const mergeBase = merge.egWalker.getVersion();
	merge.getMap().getArray("content").insert(0, ["M"]);
	const mergeNew = merge.egWalker.graph.getChangesSince(mergeBase);

	const afterMerge = [...baseEvents, ...delNew, ...insNew, ...mergeNew];

	const rA = new Doc("rA");
	rA.egWalker.integrateRemote(afterMerge);
	const rABase = rA.egWalker.getVersion();
	rA.getMap().getArray("content").insert(0, ["Y"]);
	const rANew = rA.egWalker.graph.getChangesSince(rABase);

	const rB = new Doc("rB");
	rB.egWalker.integrateRemote(afterMerge);
	const rBBase = rB.egWalker.getVersion();
	rB.getMap().getArray("content").insert(0, ["Z"]);
	const rBNew = rB.egWalker.graph.getChangesSince(rBBase);

	const allNew = [...delNew, ...insNew, ...mergeNew, ...rANew, ...rBNew];

	// Reference: integrate everything with NO compaction.
	const reference = new Doc("ref");
	reference.egWalker.integrateRemote([...baseEvents, ...allNew]);

	return { server, baseEvents, allNew, reference, insertAfterId };
}

/**
 * PLAN_10 — GC during compaction can drop tombstones still needed as RGA anchors.
 *
 * The concern: compaction rebuilds state at the critical version and calls
 * `gc(true)`, permanently removing tombstones from the snapshot. Tombstones are
 * RGA insertion anchors; if a *remaining* event (kept because it is concurrent
 * with / after the critical version) anchors `afterId` at a character deleted
 * at-or-before the critical version and gc'd out of the snapshot, the anchor is
 * gone and `rgaInsertIndex` falls back to append-at-end — silently reordering.
 *
 * These tests establish that the condition cannot arise through the public API.
 * The index-based insert only ever anchors to a *visible* predecessor, so an
 * insert with `afterId = X` must have been authored on a replica that had not
 * yet seen X's deletion (the insert is concurrent with the delete). For X to be
 * a tombstone in the snapshot, delete-X must be an ancestor of the critical
 * version `c`; but a remaining event is a strict descendant of `c`, hence a
 * descendant of delete-X — so it would have seen the delete and could not have
 * anchored to X. The two requirements are mutually exclusive. These stay as
 * regression/documentation tests.
 */
describe("PLAN_10 — compaction gc does not orphan RGA anchors", () => {
	it("compaction that gc's a folded tombstone still converges to the non-compacted result", async () => {
		const { server, allNew, reference, insertAfterId } =
			await buildScenario("gc-anchor-room");
		const expected = reference.getMap().getArray("content").toJSON();

		server.getDoc().egWalker.integrateRemote(allNew);
		await server.compact();

		// The compaction must have folded history (a snapshot event exists) and
		// left genuine remaining events, or the test would prove nothing.
		const events = server.getDoc().egWalker.graph.getAllEvents();
		expect(events.some((e) => e.op.type === "snapshot")).toBe(true);
		expect(events.some((e) => e.op.type !== "snapshot")).toBe(true);

		// gc actually removed the deleted anchor X from the snapshot state — this
		// is the exact tombstone PLAN_10 feared losing.
		const snapshotIds = collectItemIds(server.getDoc().egWalker.getStateSnapshot());
		expect(insertAfterId).not.toBeNull();
		expect(snapshotIds.has(insertAfterId!)).toBe(false);

		// Despite X being gone, the compacted server converges to the exact same
		// content as the non-compacted reference: no silent reordering.
		expect(server.getDoc().getMap().getArray("content").toJSON()).toEqual(expected);

		// A fresh client loading only the post-compaction snapshot also converges.
		const late = new Doc("late");
		late.egWalker.loadStateSnapshot(server.getDoc().egWalker.getStateSnapshot());
		expect(late.getMap().getArray("content").toJSON()).toEqual(expected);
	});

	it("no remaining event anchors afterId at an item absent from the post-gc snapshot", async () => {
		const { server, allNew } = await buildScenario("gc-anchor-room-2");

		server.getDoc().egWalker.integrateRemote(allNew);
		await server.compact();

		// Every id present in the post-compaction snapshot (snapshots preserve
		// surviving items via toSnapshot; gc during compaction removes tombstones).
		const presentIds = collectItemIds(server.getDoc().egWalker.getStateSnapshot());

		const remaining = server
			.getDoc()
			.egWalker.graph.getAllEvents()
			.filter((e) => e.op.type !== "snapshot");
		expect(remaining.length).toBeGreaterThan(0);

		// The core invariant: no remaining insert op anchors to an id missing from
		// the snapshot. If this ever fails, gc dropped a still-referenced anchor.
		for (const ev of remaining) {
			if (ev.op.type === "array-insert" && ev.op.afterId !== null) {
				expect(presentIds.has(ev.op.afterId)).toBe(true);
			}
		}
	});
});
