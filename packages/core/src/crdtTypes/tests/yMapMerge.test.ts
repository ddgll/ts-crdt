import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";

describe("YMap merge", () => {
	it("should deep clone nested CRDTs when merged from another document", () => {
		const doc1 = new Doc("doc1");
		const map1 = doc1.getMap();
		const nestedMap1 = map1.getMap("nested");
		nestedMap1.set("key", "value1");
		map1.getArray("arr").insert(0, ["item1"]);

		const doc2 = new Doc("doc2");
		const map2 = doc2.getMap();
		map2.set("primitive", "value2");

		// Merge doc1's map into doc2's map
		map2.merge(map1);

		// Assert values are merged
		expect(map2.get("primitive")).toBe("value2");
		expect(map2.getMap("nested").get("key")).toBe("value1");
		expect(map2.getArray("arr").get(0)).toBe("item1");

		// Modify nested CRDTs on doc2
		map2.getMap("nested").set("key", "value2");
		map2.getArray("arr").insert(1, ["item2"]);

		// doc2 modifications should NOT affect doc1
		expect(map1.getMap("nested").get("key")).toBe("value1");
		expect(map1.getArray("arr").length).toBe(1);

		// The events should be generated in doc2's walker
		const doc2Events = Array.from(doc2.egWalker.graph.events.values());
		const lastEvent = doc2Events[doc2Events.length - 1];
		expect(lastEvent.id).toContain("doc2:");
	});
});
