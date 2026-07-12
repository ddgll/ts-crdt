import { describe, it, expect } from 'vitest';
import {
  CrdtEvent,
  MAP_SET_OP,
  ARRAY_INSERT_OP,
  ARRAY_DELETE_OP,
  Op,
} from "../../eventGraph/eventGraph.js";
import { Doc } from "../../crdtTypes/doc.js";

describe("EgWalker.addEvent", () => {
  it("add valid map set event", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const event: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
    };
    walker.integrateRemote([event]);
    expect(doc.getMap().get("foo")).toEqual("bar");
  });

  it("add valid array insert event", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const items = doc.getMap().getArray("items");
    const event: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: [],
      op: { type: ARRAY_INSERT_OP, path: ["items"], afterId: null, values: ["a"] },
    };
    walker.integrateRemote([event]);
    expect(items.get(0) as string).toEqual("a");
  });

  it("add valid array delete event", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const items = doc.getMap().getArray("items");
    items.insert(0, ["a", "b", "c"]);

    const insertEvent = doc.egWalker.getStateSnapshot().graph.events.find(e => e[1].op.type === ARRAY_INSERT_OP)?.[1];
    const deleteEvent: CrdtEvent = {
      id: "r1:4", // after 3 inserts
      replicaId: "r1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parents: (walker as any)["graph"].getVersion(),
      op: { type: ARRAY_DELETE_OP, path: ["items"], targetIds: [`${insertEvent!.id}:1`] },
    };
    walker.integrateRemote([deleteEvent]);
    expect((items.toJSON() as string[]).join("")).toEqual("ac");
  });

  it("handle event with non-existent parent", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const event: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: ["non-existent"],
      op: { type: ARRAY_INSERT_OP, path: ["items"], afterId: null, values: ["a"] },
    };
    // Integration is tolerant of missing parents: the event is buffered rather
    // than thrown, and is not applied until its parent arrives.
    const added = walker.integrateRemote([event]);
    expect(added).toEqual([]);
    expect(walker.getPendingEventCount()).toBe(1);
    expect(doc.getMap().get("items")).toBeUndefined();
  });

  it("integrates a buffered orphan once its missing parent arrives", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const parent: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    const child: CrdtEvent = {
      id: "r1:2",
      replicaId: "r1",
      parents: ["r1:1"],
      op: { type: MAP_SET_OP, path: [], key: "b", value: 2 },
    };

    // Child arrives first (out of order) → buffered.
    expect(walker.integrateRemote([child])).toEqual([]);
    expect(walker.getPendingEventCount()).toBe(1);
    expect(doc.getMap().get("b")).toBeUndefined();

    // Parent arrives → both integrate, in causal order.
    const added = walker.integrateRemote([parent]);
    expect(added.map((e) => e.id)).toEqual(["r1:1", "r1:2"]);
    expect(walker.getPendingEventCount()).toBe(0);
    expect(doc.getMap().get("a")).toBe(1);
    expect(doc.getMap().get("b")).toBe(2);
  });

  it("handle duplicate event", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const event: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
    };
    walker.integrateRemote([event]);
    walker.integrateRemote([event]); // Should be ignored
    expect(doc.getMap().get("foo")).toEqual("bar");
  });

  it("handle invalid event operation", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const good: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
    };
    const invalid: CrdtEvent = {
      id: "r1:2",
      replicaId: "r1",
      parents: ["r1:1"],
      op: {
        type: "invalid_op",
      } as unknown as Op,
    };
    // A structurally invalid event is dropped (logged), not thrown, so it can
    // never abort the batch. The valid event in the same batch still applies.
    const added = walker.integrateRemote([good, invalid]);
    expect(added.map((e) => e.id)).toEqual(["r1:1"]);
    expect(walker.getPendingEventCount()).toBe(0);
    expect(doc.getMap().get("foo")).toEqual("bar");
  });

});
