import {
  CrdtEvent,
  EventGraphError,
  MAP_SET_OP,
  ARRAY_INSERT_OP,
  ARRAY_DELETE_OP,
  Op,
} from "../../eventGraph/eventGraph.js";
import { Doc } from "../../crdtTypes/Doc.js";

test("EgWalker.addEvent - add valid map set event", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
  };
  walker.addEvent(event);
  expect(doc.getMap().get("foo")).toEqual("bar");
});

test("EgWalker.addEvent - add valid array insert event", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const items = doc.getMap().getArray("items");
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path: ["items"], index: 0, values: ["a"] },
  };
  walker.addEvent(event);
  expect(items.get(0) as string).toEqual("a");
});

test("EgWalker.addEvent - add valid array delete event", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const items = doc.getMap().getArray("items");
  items.insert(0, ["a", "b", "c"]);

  const deleteEvent: CrdtEvent = {
    id: "4", // after 3 inserts
    replicaId: "r1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parents: (walker as any)["graph"].getVersion(),
    op: { type: ARRAY_DELETE_OP, path: ["items"], index: 1, length: 1 },
  };
  walker.addEvent(deleteEvent);
  expect((items.toJSON() as string[]).join("")).toEqual("ac");
});

test("EgWalker.addEvent - handle event with non-existent parent", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: ["non-existent"],
    op: { type: ARRAY_INSERT_OP, path: ["items"], index: 0, values: ["a"] },
  };
  expect(() => walker.addEvent(event)).toThrow(
    new EventGraphError("Invalid parent")
  );
});

test("EgWalker.addEvent - handle duplicate event", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
  };
  walker.addEvent(event);
  walker.addEvent(event); // Should be ignored
  expect(doc.getMap().get("foo")).toEqual("bar");
});

test("EgWalker.addEvent - handle invalid event operation", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: "invalid_op",
    } as unknown as Op,
  };
  expect(() => walker.addEvent(event)).toThrow("Invalid operation type");
});

test("EgWalker.addEvent - handle event with invalid index", () => {
  const doc = new Doc();
  const walker = doc.egWalker;
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path: ["items"], index: -1, values: ["a"] },
  };
  expect(() => walker.addEvent(event)).toThrow("Invalid index");
});
