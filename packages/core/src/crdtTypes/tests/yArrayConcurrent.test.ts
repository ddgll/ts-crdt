import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";

describe("YArray and YText Concurrent Edits", () => {
	it("should merge concurrent YArray inserts deterministically", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Initial state
		doc1.getMap().getArray("arr").insert(0, ["A"]);
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// Concurrent inserts at the same index
		doc1.getMap().getArray("arr").insert(1, ["B"]); // doc1 inserts B after A
		doc2.getMap().getArray("arr").insert(1, ["C"]); // doc2 inserts C after A

		// Sync
		const doc1LastEvent = doc1.egWalker.graph.getAllEvents().pop()!;
		const doc2LastEvent = doc2.egWalker.graph.getAllEvents().pop()!;
		doc1.egWalker.integrateRemote([doc2LastEvent]);
		doc2.egWalker.integrateRemote([doc1LastEvent]);

		// Note: YArray resolves concurrent index-based ops via deterministic replay.
		// Both inserts are applied based on event ID sort order during rebuild.
		// As documented, it is not a proper Sequence CRDT (like RGA) and should not
		// be used for real-time collaborative text character-by-character editing.
		expect(doc1.getMap().getArray("arr").toJSON()).toEqual(doc2.getMap().getArray("arr").toJSON());
		
		// Wait, because event graph sorts events deterministically, one event will be processed before another
		// e.g., 'replica1:1' and 'replica2:1'. The sorting is deterministic, so both replicas converge.
	});

	it("should merge concurrent YText inserts deterministically", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		doc1.getMap().getText("txt").insert(0, "A");
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		doc1.getMap().getText("txt").insert(1, "B");
		doc2.getMap().getText("txt").insert(1, "C");

		const doc1LastTextEvent = doc1.egWalker.graph.getAllEvents().pop()!;
		const doc2LastTextEvent = doc2.egWalker.graph.getAllEvents().pop()!;
		doc1.egWalker.integrateRemote([doc2LastTextEvent]);
		doc2.egWalker.integrateRemote([doc1LastTextEvent]);

		// YText converges deterministically in the same way.
		expect(doc1.getMap().getText("txt").toString()).toEqual(doc2.getMap().getText("txt").toString());
	});
	it("should merge concurrent YArray inserts deterministically without a full rebuild (incremental fast-path)", () => {
		const doc1 = new Doc("replicaA");
		const doc2 = new Doc("replicaB");

		doc1.getMap().getArray("arr").insert(0, ["Anchor"]);
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// Concurrent inserts after "Anchor"
		doc1.getMap().getArray("arr").insert(1, ["FromA"]);
		doc2.getMap().getArray("arr").insert(1, ["FromB"]);

		// Sync 1 to 2
		const doc1LastEvent = doc1.egWalker.graph.getAllEvents().pop()!;
		doc2.egWalker.integrateRemote([doc1LastEvent]);
		
		// Sync 2 to 1
		const doc2LastEvent = doc2.egWalker.graph.getAllEvents().find(e => e.op.type === "array-insert" && (e.op as { values: unknown[] }).values[0] === "FromB")!;
		doc1.egWalker.integrateRemote([doc2LastEvent]);

		// Both should match perfectly without needing a clear/rebuild.
		// "replicaA" should deterministically order before "replicaB"
		expect(doc1.getMap().getArray("arr").toJSON()).toEqual(["Anchor", "FromA", "FromB"]);
		expect(doc2.getMap().getArray("arr").toJSON()).toEqual(["Anchor", "FromA", "FromB"]);
	});
});
