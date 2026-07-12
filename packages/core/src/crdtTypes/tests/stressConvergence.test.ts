import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

/** Deterministic PRNG so a failing seed is reproducible. */
function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Seeded Fisher-Yates shuffle producing a new array. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** Union of every event across the given replicas, de-duplicated by id. */
function collectAllEvents(replicas: Doc[]): CrdtEvent[] {
	const byId = new Map<string, CrdtEvent>();
	for (const r of replicas) {
		for (const ev of r.egWalker.graph.getAllEvents()) {
			byId.set(ev.id, ev);
		}
	}
	return Array.from(byId.values());
}

describe("Stress: Multi-writer convergence", () => {
    it("should converge with 10 concurrent writers on YMap", () => {
        const replicas = Array.from({ length: 10 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        // Each replica sets a different key
        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 10; i++) {
            replicas[i].getMap().set(`key-${i}`, `value-${i}`);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        // Integrate all events into all replicas
        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        // Verify convergence
        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 10; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });

    it("should converge with 10 concurrent writers on same YMap key", () => {
        const replicas = Array.from({ length: 10 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 10; i++) {
            replicas[i].getMap().set(`key`, `value-${i}`);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 10; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });

    it("should converge with 5 concurrent writers on YArray", () => {
        const replicas = Array.from({ length: 5 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        // All inserting at index 0 initially
        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 5; i++) {
            replicas[i].getMap().getArray("arr").insert(0, [`value-${i}`]);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 5; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });

    it("should converge with 5 concurrent writers on YText", () => {
        const replicas = Array.from({ length: 5 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 5; i++) {
            replicas[i].getMap().getText("text").insert(0, `A${i}`);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 5; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });
});

// The targeted PLAN_02 convergence checks: 3+ replicas making randomized,
// multi-anchor concurrent inserts/deletes, then integrating every event in a
// different per-replica order. All replicas must reach a byte-identical state.
describe("Stress: RGA multi-anchor convergence (PLAN_02)", () => {
	const SEEDS = Array.from({ length: 30 }, (_, i) => i * 7 + 1);
	const REPLICA_COUNT = 4;
	const OPS_PER_REPLICA = 8;

	it("converges YArray under randomized concurrent inserts/deletes across replicas", () => {
		for (const seed of SEEDS) {
			const rand = mulberry32(seed);
			const replicas = Array.from(
				{ length: REPLICA_COUNT },
				(_, i) => new Doc(`r${i}`),
			);

			// Shared causal base so every subsequent op is concurrent.
			replicas[0].getMap().getArray("arr").insert(0, ["base0", "base1", "base2"]);
			const base = replicas[0].egWalker.graph.getAllEvents();
			for (let i = 1; i < replicas.length; i++) {
				replicas[i].egWalker.integrateRemote(base);
			}

			// Each replica makes concurrent edits without seeing the others.
			for (let i = 0; i < replicas.length; i++) {
				for (let op = 0; op < OPS_PER_REPLICA; op++) {
					const arr = replicas[i].getMap().getArray("arr");
					const len = arr.length;
					if (len === 0 || rand() < 0.65) {
						const idx = Math.floor(rand() * (len + 1));
						arr.insert(idx, [`r${i}-v${op}`]);
					} else {
						const idx = Math.floor(rand() * len);
						arr.delete(idx, 1);
					}
				}
			}

			// Deliver the full event set to every replica in a different order.
			const allEvents = collectAllEvents(replicas);
			for (let i = 0; i < replicas.length; i++) {
				replicas[i].egWalker.integrateRemote(
					shuffle(allEvents, mulberry32(seed * 131 + i)),
				);
			}

			const expected = JSON.stringify(replicas[0].getMap().getArray("arr").toJSON());
			for (let i = 1; i < replicas.length; i++) {
				expect(
					JSON.stringify(replicas[i].getMap().getArray("arr").toJSON()),
					`YArray divergence at seed ${seed}, replica ${i}`,
				).toBe(expected);
			}
			// No orphaned events should remain buffered.
			for (const r of replicas) {
				expect(r.egWalker.getPendingEventCount()).toBe(0);
			}
		}
	});

	it("converges YText under randomized concurrent inserts/deletes across replicas", () => {
		for (const seed of SEEDS) {
			const rand = mulberry32(seed + 9999);
			const replicas = Array.from(
				{ length: REPLICA_COUNT },
				(_, i) => new Doc(`r${i}`),
			);

			replicas[0].getMap().getText("txt").insert(0, "seed");
			const base = replicas[0].egWalker.graph.getAllEvents();
			for (let i = 1; i < replicas.length; i++) {
				replicas[i].egWalker.integrateRemote(base);
			}

			for (let i = 0; i < replicas.length; i++) {
				for (let op = 0; op < OPS_PER_REPLICA; op++) {
					const txt = replicas[i].getMap().getText("txt");
					const len = txt.toString().length;
					if (len === 0 || rand() < 0.65) {
						const idx = Math.floor(rand() * (len + 1));
						// Distinct char per (replica, op) helps surface misordering.
						const ch = String.fromCharCode(65 + i) + op;
						txt.insert(idx, ch);
					} else {
						const idx = Math.floor(rand() * len);
						txt.delete(idx, 1);
					}
				}
			}

			const allEvents = collectAllEvents(replicas);
			for (let i = 0; i < replicas.length; i++) {
				replicas[i].egWalker.integrateRemote(
					shuffle(allEvents, mulberry32(seed * 977 + i)),
				);
			}

			const expected = replicas[0].getMap().getText("txt").toString();
			for (let i = 1; i < replicas.length; i++) {
				expect(
					replicas[i].getMap().getText("txt").toString(),
					`YText divergence at seed ${seed}, replica ${i}`,
				).toBe(expected);
			}
			for (const r of replicas) {
				expect(r.egWalker.getPendingEventCount()).toBe(0);
			}
		}
	});
});
