import { describe, it, expect } from 'vitest';
import {
  CrdtEvent,
  EventGraphError,
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
    walker.addEvent(event);
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
    walker.addEvent(event);
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
    walker.addEvent(deleteEvent);
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
    expect(() => walker.addEvent(event)).toThrow(
      new EventGraphError("Invalid parent")
    );
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
    walker.addEvent(event);
    walker.addEvent(event); // Should be ignored
    expect(doc.getMap().get("foo")).toEqual("bar");
  });

  it("handle invalid event operation", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const event: CrdtEvent = {
      id: "r1:1",
      replicaId: "r1",
      parents: [],
      op: {
        type: "invalid_op",
      } as unknown as Op,
    };
    expect(() => walker.addEvent(event)).toThrow("Invalid operation type");
  });

});
