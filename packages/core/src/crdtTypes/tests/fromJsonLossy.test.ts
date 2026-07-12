import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";
import { YArray } from "../yArray.js";
import { YText } from "../yText.js";

/**
 * PLAN_07.2 — `Doc.fromJSON` (and the underlying YArray.fromJSON /
 * YText.fromString) are intentionally lossy and NON-collaborative: they assign
 * synthetic path-derived ids and drop tombstones. These tests document that loss
 * so the behaviour is intentional and regressions are caught, and steer callers
 * toward snapshot-based loading for real sync flows.
 */
describe("PLAN_07.2 — Doc.fromJSON is lossy / non-collaborative", () => {
	it("assigns synthetic path-derived RGA ids (not real event ids)", () => {
		const doc = Doc.fromJSON({ list: { __crdt_type: "YArray", data: ["x", "y", "z"] } });
		const list = doc.getMap().get("list");
		expect(list).toBeInstanceOf(YArray);

		// Reach into the internal representation to prove the ids are synthetic.
		const internal = list as unknown as { _data: { id: string }[] };
		expect(internal._data.map((i) => i.id)).toEqual([
			"snapshot:list:0",
			"snapshot:list:1",
			"snapshot:list:2",
		]);
	});

	it("YText loaded from a string shares a single synthetic anchor id", () => {
		const doc = Doc.fromJSON({ note: { __crdt_type: "YText", data: "hello" } });
		const note = doc.getMap().get("note");
		expect(note).toBeInstanceOf(YText);
		const internal = note as unknown as { _data: { id: string }[] };
		// Every character derives its id from the same synthetic anchor.
		for (const item of internal._data) {
			expect(item.id.startsWith("snapshot:note")).toBe(true);
		}
	});

	it("synthetic ids collide across independently-loaded replicas (why it is unsafe to sync)", () => {
		const a = Doc.fromJSON({ list: { __crdt_type: "YArray", data: ["x"] } });
		const b = Doc.fromJSON({ list: { __crdt_type: "YArray", data: ["x"] } });
		const idA = (a.getMap().get("list") as unknown as { _data: { id: string }[] })._data[0].id;
		const idB = (b.getMap().get("list") as unknown as { _data: { id: string }[] })._data[0].id;
		// Two independent replicas produce the SAME id — a collision that would
		// break convergence, hence the lossy/non-collaborative contract.
		expect(idA).toBe(idB);
	});

	it("round-trips values (JSON view) even though CRDT identity is lost", () => {
		const original = { list: ["a", "b"], count: 3 };
		const doc = Doc.fromJSON(original);
		expect(doc.toJSON()).toEqual(original);
	});
});
