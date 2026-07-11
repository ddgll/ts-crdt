import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";
import { YMap } from "../yMap.js";

describe("Doc", () => {
  it("should handle nested maps", () => {
    const doc = new Doc();
    const root = doc.getMap();
    const userMap = root.getMap("user");
    userMap.set("name", "David");

    const expected = {
      user: {
        __crdt_type: "YMap",
        data: {
          name: "David",
        },
      },
    };
    expect(doc.toJSON()).toEqual(expected);
  });

  it("should apply updates to nested maps", () => {
    const doc = new Doc();
    const root = doc.getMap();
    // Ensure the user map exists before applying an update to it.
    // In a real scenario, this might be created by another user or a previous operation.
    root.getMap("user");

    const update = {
      path: ["user"],
      payload: {
        type: "set",
        key: "name",
        value: "David",
      },
    };

    doc.applyUpdate(update);

    const userMap = doc.getMap().get("user") as YMap;
    expect(userMap.get("name")).toEqual("David");
  });
	it("should generate a new replicaId on clear()", () => {
		const doc = new Doc("replica123");
		const root = doc.getMap();
		root.getMap("user").set("name", "Alice");

		doc.clear();

		expect(doc.egWalker.getReplicaId()).not.toEqual("replica123");
		expect(doc.toJSON()).toEqual({});
	});
});
