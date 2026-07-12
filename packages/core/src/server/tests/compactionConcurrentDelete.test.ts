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
 * PLAN_07.4 — lock down compaction interactions with concurrent deletes and
 * confirm post-compaction id monotonicity, both of which are argued safe today.
 */
describe("PLAN_07.4 — compaction + concurrent delete", () => {
	it("converges when a delete and an insert-after are concurrent across the critical version", async () => {
		const server = new CrdtServer("cd-room", makeRepo());
		await server.initialize();

		// Client 1 seeds content a, b, c.
		const c1 = new Doc("c1");
		c1.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
		c1.getMap().getArray("content").insert(0, ["a", "b", "c"]);
		server.getDoc().egWalker.integrateRemote(c1.egWalker.graph.getAllEvents());

		// Snapshot the single-head base (H0) both concurrent clients branch from.
		const baseEvents = server.getDoc().egWalker.graph.getAllEvents();

		const c2 = new Doc("c2");
		c2.egWalker.integrateRemote(baseEvents);
		const c2Base = c2.egWalker.getVersion();
		c2.getMap().getArray("content").delete(1, 1); // delete "b"
		const c2New = c2.egWalker.graph.getChangesSince(c2Base);

		const c3 = new Doc("c3");
		c3.egWalker.integrateRemote(baseEvents);
		const c3Base = c3.egWalker.getVersion();
		c3.getMap().getArray("content").insert(2, ["X"]); // insert after "b"
		const c3New = c3.egWalker.graph.getChangesSince(c3Base);

		// Reference doc: integrate everything with NO compaction.
		const reference = new Doc("ref");
		reference.egWalker.integrateRemote([...baseEvents, ...c2New, ...c3New]);
		const expected = reference.getMap().getArray("content").toJSON();

		// Server integrates both concurrent branches → multiple heads.
		server.getDoc().egWalker.integrateRemote(c2New);
		server.getDoc().egWalker.integrateRemote(c3New);

		// Compact (critical version is H0, where "b" still exists and is preserved).
		await server.compact();

		// Server converges to the same content as the non-compacted reference.
		expect(server.getDoc().getMap().getArray("content").toJSON()).toEqual(expected);

		// A fresh client loading the post-compaction snapshot also converges.
		const late = new Doc("late");
		late.egWalker.loadStateSnapshot(server.getDoc().egWalker.getStateSnapshot());
		expect(late.getMap().getArray("content").toJSON()).toEqual(expected);
	});

	it("does not let a client reissue an id folded into the snapshot after compaction", async () => {
		const server = new CrdtServer("cd-room-2", makeRepo());
		await server.initialize();

		const client = new Doc("client-mono");
		client.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());

		// Client makes several edits; capture their ids.
		for (let i = 0; i < 4; i++) {
			client.getMap().set(`k${i}`, i);
		}
		const clientEventIds = client.egWalker.graph
			.getAllEvents()
			.filter((e) => e.replicaId === "client-mono")
			.map((e) => e.id);
		const maxSeqBefore = Math.max(...clientEventIds.map((id) => parseInt(id.split(":")[1], 10)));

		// Server integrates and compacts, folding the client edits into a snapshot.
		server.getDoc().egWalker.integrateRemote(client.egWalker.graph.getAllEvents());
		await server.compact();

		// Client loads the post-compaction snapshot and issues a NEW edit.
		client.egWalker.loadStateSnapshot(server.getDoc().egWalker.getStateSnapshot());
		client.getMap().set("after-compaction", true);

		const newEvent = client.egWalker.graph
			.getAllEvents()
			.filter((e) => e.replicaId === "client-mono")
			.sort((a, b) => parseInt(b.id.split(":")[1], 10) - parseInt(a.id.split(":")[1], 10))[0];
		const newSeq = parseInt(newEvent.id.split(":")[1], 10);

		// The new id must be strictly beyond every previously-issued id (monotonic
		// sequence never resets down), so it cannot collide with a folded id.
		expect(newSeq).toBeGreaterThan(maxSeqBefore);
		expect(clientEventIds).not.toContain(newEvent.id);
	});
});
