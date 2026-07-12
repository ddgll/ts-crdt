import { describe, it, expect } from "vitest";
import { BufferedRepository } from "../bufferedRepository.js";
import { Repository } from "../crdtServer.js";
import { CrdtEvent } from "../../index.js";

function makeEvent(id: string): CrdtEvent {
	return { id, replicaId: id.split(":")[0], parents: [], op: { type: "map-set", path: [], key: id, value: 1 } };
}

/**
 * PLAN_07.3 — during flush(), the batch is removed from `buffer` before the
 * async `saveEvents` resolves. Previously a concurrent getEvents() could observe
 * events in neither `buffer` nor the persisted store (a momentary gap). The
 * `inFlight` list closes that window.
 */
describe("PLAN_07.3 — BufferedRepository has no gap during flush", () => {
	it("getEvents() sees in-flight events while saveEvents is pending", async () => {
		let resolveSave: (() => void) | null = null;
		const target: Repository & { events: CrdtEvent[] } = {
			events: [],
			async getEvents() {
				return this.events;
			},
			async saveEvents(evs) {
				await new Promise<void>((r) => {
					resolveSave = r;
				});
				this.events.push(...evs);
			},
			async clearEvents() {
				this.events = [];
			},
		};

		const buffered = new BufferedRepository(target, { batchSize: 1, flushIntervalMs: 10_000 });

		// Triggers an immediate flush; target.saveEvents stays pending.
		const savePromise = buffered.saveEvents([makeEvent("1")]);

		// Let the flush reach the pending saveEvents.
		await Promise.resolve();
		await Promise.resolve();

		// The event is neither in `buffer` nor yet persisted — but must still be
		// visible via `inFlight`.
		const during = await buffered.getEvents();
		expect(during.map((e) => e.id)).toContain("1");

		// Complete the save and confirm no duplication after it lands.
		resolveSave?.();
		await savePromise;

		const after = await buffered.getEvents();
		expect(after.map((e) => e.id)).toEqual(["1"]);
	});

	it("keeps events visible after a failed flush", async () => {
		let shouldFail = true;
		const target: Repository & { events: CrdtEvent[] } = {
			events: [],
			async getEvents() {
				return this.events;
			},
			async saveEvents(evs) {
				if (shouldFail) throw new Error("simulated write failure");
				this.events.push(...evs);
			},
			async clearEvents() {
				this.events = [];
			},
		};

		const buffered = new BufferedRepository(target, { batchSize: 1, flushIntervalMs: 10_000 });

		await expect(buffered.saveEvents([makeEvent("1")])).rejects.toThrow();

		// Even after the failure, the event must remain visible (back in buffer).
		const visible = await buffered.getEvents();
		expect(visible.map((e) => e.id)).toEqual(["1"]);

		// Recover and flush; still exactly one copy.
		shouldFail = false;
		await buffered.flush();
		const final = await buffered.getEvents();
		expect(final.map((e) => e.id)).toEqual(["1"]);
	});
});
