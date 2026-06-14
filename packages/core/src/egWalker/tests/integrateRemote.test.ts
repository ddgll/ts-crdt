import { describe, expect, it } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtEvent, MAP_SET_OP } from "../../eventGraph/eventGraph.js";

describe("EgWalker.integrateRemote", () => {
  it("integrate remote events", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const event: CrdtEvent = {
      id: "1",
      replicaId: "r1",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
    };
    walker.integrateRemote([event]);
    expect(doc.getMap().get("foo")).toEqual("bar");
  });
});
