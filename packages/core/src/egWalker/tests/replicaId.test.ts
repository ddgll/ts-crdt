import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { generateReplicaId } from "../egWalker.js";

describe("PLAN_07.1 — strong default replica ids", () => {
	it("generateReplicaId produces unique ids without ':'", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const id = generateReplicaId();
			expect(id).not.toContain(":");
			expect(id.length).toBeGreaterThanOrEqual(11);
			ids.add(id);
		}
		// No collisions across 1000 draws.
		expect(ids.size).toBe(1000);
	});

	it("a Doc created without an explicit replicaId gets a strong, unique id", () => {
		const a = new Doc();
		const b = new Doc();
		expect(a.egWalker.getReplicaId()).not.toBe(b.egWalker.getReplicaId());
		expect(a.egWalker.getReplicaId()).not.toContain(":");
	});

	it("generated ids are valid as the replicaId half of an event id", () => {
		const doc = new Doc();
		doc.getMap().set("k", "v");
		const [event] = doc.egWalker.graph.getSortedEvents();
		// Event ids are `${replicaId}:${seq}` and must match the isCrdtEvent regex.
		expect(event.id).toMatch(/^[^:]+:\d+$/);
		expect(event.replicaId).toBe(doc.egWalker.getReplicaId());
	});
});
