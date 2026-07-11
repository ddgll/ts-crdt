import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";

describe("YText Concurrent Edits", () => {
	it("should merge concurrent inserts at different positions deterministically", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Both start with "Hello"
		doc1.getMap().getText("txt").insert(0, "Hello");
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// doc1 inserts at end, doc2 inserts at beginning — concurrently
		doc1.getMap().getText("txt").insert(5, " World");
		doc2.getMap().getText("txt").insert(0, "Hi ");

		// Sync
		const doc1Events = doc1.egWalker.graph.getAllEvents();
		const doc2Events = doc2.egWalker.graph.getAllEvents();
		doc1.egWalker.integrateRemote(doc2Events);
		doc2.egWalker.integrateRemote(doc1Events);

		// Both replicas must converge to the same string
		expect(doc1.getMap().getText("txt").toString()).toEqual(
			doc2.getMap().getText("txt").toString(),
		);
	});

	it("should merge concurrent insert and delete at same position deterministically", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Both start with "ABCDE"
		doc1.getMap().getText("txt").insert(0, "ABCDE");
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// doc1 deletes "BC" (index 1, length 2), doc2 inserts "X" at index 2
		doc1.getMap().getText("txt").delete(1, 2);
		doc2.getMap().getText("txt").insert(2, "X");

		// Sync
		const doc1Events = doc1.egWalker.graph.getAllEvents();
		const doc2Events = doc2.egWalker.graph.getAllEvents();
		doc1.egWalker.integrateRemote(doc2Events);
		doc2.egWalker.integrateRemote(doc1Events);

		// Both replicas must converge
		expect(doc1.getMap().getText("txt").toString()).toEqual(
			doc2.getMap().getText("txt").toString(),
		);
	});

	it("should merge concurrent formatting and insert deterministically", () => {
		const doc1 = new Doc("replica1");
		const doc2 = new Doc("replica2");

		// Both start with "Hello"
		doc1.getMap().getText("txt").insert(0, "Hello");
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// doc1 formats "Hello" as bold, doc2 inserts " World"
		doc1.getMap().getText("txt").format(0, 5, { bold: true });
		doc2.getMap().getText("txt").insert(5, " World");

		// Sync
		const doc1Events = doc1.egWalker.graph.getAllEvents();
		const doc2Events = doc2.egWalker.graph.getAllEvents();
		doc1.egWalker.integrateRemote(doc2Events);
		doc2.egWalker.integrateRemote(doc1Events);

		// Text should converge
		expect(doc1.getMap().getText("txt").toString()).toEqual(
			doc2.getMap().getText("txt").toString(),
		);
		// Formatting should be present on both
		expect(doc1.getMap().getText("txt").getFormatting().length).toEqual(
			doc2.getMap().getText("txt").getFormatting().length,
		);
	});
	it("should merge concurrent YText inserts deterministically without a full rebuild (incremental fast-path)", () => {
		const doc1 = new Doc("replicaA");
		const doc2 = new Doc("replicaB");

		doc1.getMap().getText("txt").insert(0, "X");
		doc2.egWalker.integrateRemote(doc1.egWalker.graph.getAllEvents());

		// Concurrent inserts after "X"
		doc1.getMap().getText("txt").insert(1, "A");
		doc2.getMap().getText("txt").insert(1, "B");

		// Sync 1 to 2
		const doc1LastEvent = doc1.egWalker.graph.getAllEvents().pop()!;
		doc2.egWalker.integrateRemote([doc1LastEvent]);
		
		// Sync 2 to 1
		const doc2LastEvent = doc2.egWalker.graph.getAllEvents().find(e => e.op.type === "text-insert" && (e.op as { text: string }).text === "B")!;
		doc1.egWalker.integrateRemote([doc2LastEvent]);

		// "replicaA" sorts before "replicaB", so A should be before B
		expect(doc1.getMap().getText("txt").toString()).toEqual("XAB");
		expect(doc2.getMap().getText("txt").toString()).toEqual("XAB");
	});
});
