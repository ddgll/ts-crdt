import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import {
	CrdtEvent,
	isCrdtEvent,
	MAP_SET_OP,
} from "../../eventGraph/eventGraph.js";

describe("prototype pollution hardening (PLAN_14)", () => {
	it("isCrdtEvent rejects dangerous path segments and map keys", () => {
		const base = {
			id: "r1:1",
			replicaId: "r1",
			parents: [] as string[],
		};
		// Dangerous path segment.
		expect(
			isCrdtEvent({
				...base,
				op: { type: MAP_SET_OP, path: ["__proto__"], key: "k", value: "v" },
			}),
		).toBe(false);
		// Dangerous map-set key (including "prototype", newly covered).
		expect(
			isCrdtEvent({
				...base,
				op: { type: MAP_SET_OP, path: [], key: "constructor", value: "v" },
			}),
		).toBe(false);
		expect(
			isCrdtEvent({
				...base,
				op: { type: MAP_SET_OP, path: [], key: "prototype", value: "v" },
			}),
		).toBe(false);
		// A benign event is still accepted.
		expect(
			isCrdtEvent({
				...base,
				op: { type: MAP_SET_OP, path: ["a"], key: "b", value: "v" },
			}),
		).toBe(true);
	});

	it("a crafted __proto__ path segment does not pollute or throw on toJSON", () => {
		const doc = new Doc();
		const walker = doc.egWalker;

		// A crafted event whose path traverses a "__proto__" segment. This
		// bypasses the normal typed API (and the isCrdtEvent guard) and forces a
		// YMap to hold the "__proto__" key.
		const event: CrdtEvent = {
			id: "r1:1",
			replicaId: "r1",
			parents: [],
			op: { type: MAP_SET_OP, path: ["__proto__"], key: "polluted", value: "x" },
		};

		// Integrating and serializing must not throw...
		expect(() => {
			walker.integrateRemote([event]);
			doc.toJSON();
		}).not.toThrow();

		// ...and must not pollute Object.prototype.
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(
			(Object.prototype as Record<string, unknown>).polluted,
		).toBeUndefined();

		// The serialized output is a null-prototype object holding the segment as
		// an own property rather than mutating the prototype chain.
		const json = doc.toJSON() as Record<string, unknown>;
		expect(Object.getPrototypeOf(json)).toBeNull();
		expect(Object.prototype.hasOwnProperty.call(json, "__proto__")).toBe(true);
	});
});
