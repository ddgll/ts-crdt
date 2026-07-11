import { describe, it, expect, vi } from "vitest";
import { CrdtServer } from "../crdtServer.js";
import { Doc, CrdtEvent } from "../../index.js";

describe("CRDT Snapshot Metadata Preservation", () => {
	it("should preserve original event IDs and allow delayed events to apply", async () => {
		// Mock repository
		const events: CrdtEvent[] = [];
		const repo = {
			getEvents: vi.fn().mockResolvedValue(events),
			saveEvents: vi.fn(async (newEvents) => {
				events.push(...newEvents);
			}),
			clearEvents: vi.fn().mockResolvedValue(undefined),
		};

		// Initialize server and client A
		const server = new CrdtServer("room-metadata", repo, { compactionThreshold: 10 });
		await server.initialize();

		// Client A creates a document and syncs with server, then inserts text
		const docA = new Doc("replica-A");
		docA.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
		docA.getMap().getText("testText").insert(0, "hello");
		const textInsertEvents = docA.egWalker.graph.getChangesSince(server.getDoc().egWalker.getVersion());

		// Manually inject into server 
		for (const ev of textInsertEvents) {
			server.getDoc().egWalker.integrateRemote([ev]);
		}
		
		// Trigger compaction manually on the server
		await server.compact();

		// The server's graph is now compacted to a single SNAPSHOT_OP
		const compactedEvents = server.getDoc().egWalker.graph.getAllEvents();
		expect(compactedEvents.length).toBe(1);
		expect(compactedEvents[0].op.type).toBe("snapshot");

		// Client B connects and loads the compacted state
		const docB = new Doc("replica-B");
		docB.egWalker.integrateRemote(compactedEvents);
		
		// Ensure Client B has "hello"
		expect(docB.getMap().getText("testText").toString()).toBe("hello");

		// Now client B (who loaded the compacted state) performs a deletion.
		// If metadata (EventIDs) was lost during serialization, this delete would
		// fail to sync or target the wrong character, because the reconstructed YText
		// would have new synthetic IDs instead of the original ones.
		docB.getMap().getText("testText").delete(1, 1);
		
		const docBEvents = docB.egWalker.graph.getChangesSince(docA.egWalker.getVersion());
		
		// Send the delete to the server
		server.getDoc().egWalker.integrateRemote(docBEvents);
		
		// Ensure the server state correctly reflects the deletion
		expect(server.getDoc().getMap().getText("testText").toString()).toBe("hllo");
	});
});
