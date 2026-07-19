import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";

describe("YArray", () => {
  it("should insert and get elements", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b", "c"]);
    expect(arr.toJSON()).toEqual(["a", "b", "c"]);
  });

  it("should delete elements", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b", "c"]);
    arr.delete(1, 1);
    expect(arr.toJSON()).toEqual(["a", "c"]);
  });

  it("should get an element at a specific index", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b", "c"]);
    expect(arr.get(1)).toEqual("b");
  });

  it("inserts into the middle of the array (right-origin / YATA)", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, [1, 2, 3]);
    arr.insert(1, ["X"]);
    expect(arr.toJSON()).toEqual([1, "X", 2, 3]);
  });

  it("clamps an out-of-range insert index to the end", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b"]);
    arr.insert(99, ["X"]);
    expect(arr.toJSON()).toEqual(["a", "b", "X"]);
  });

  it("should break ties deterministically using sequence numbers (RGA)", () => {
    // We construct events directly to simulate sequence numbers 9 and 10
    // "replica:10" < "replica:9" in string comparison, but 10 > 9 in numeric
    const docA = new Doc("replicaA");
    const docB = new Doc("replicaB");

    // Init with an anchor element
    docA.getMap().getArray("my-array").insert(0, ["anchor"]);
    const eventsA0 = docA.egWalker.getStateSnapshot().graph.events.map(e => e[1]);
    docB.egWalker.integrateRemote(eventsA0);

    const anchorId = "replicaA:0:0"; // The item ID of the anchor

    // Manually push events to bypass Doc's sequence generator
    // We create an event with ID "replica:9"
    const event9 = {
      id: "replica:9",
      replicaId: "replica",
      parents: ["replicaA:0"],
      op: {
        type: "array-insert" as const,
        path: ["my-array"],
        afterId: anchorId,
        values: ["A"]
      }
    };

    // We create an event with ID "replica:10"
    const event10 = {
      id: "replica:10",
      replicaId: "replica",
      parents: ["replicaA:0"],
      op: {
        type: "array-insert" as const,
        path: ["my-array"],
        afterId: anchorId,
        values: ["B"]
      }
    };

    // Apply event9 then event10 to A
    docA.egWalker.integrateRemote([event9, event10]);
    // Apply event10 then event9 to B
    docB.egWalker.integrateRemote([event10, event9]);

    // Both should converge to the same state
    expect(docA.getMap().getArray("my-array").toJSON()).toEqual(
      docB.getMap().getArray("my-array").toJSON()
    );
  });
});