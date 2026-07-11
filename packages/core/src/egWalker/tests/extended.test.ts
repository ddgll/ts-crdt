import { describe, it, expect } from 'vitest';
import { Doc } from "../../crdtTypes/doc.js";
import { YMap } from "../../crdtTypes/yMap.js";
import { YArray } from "../../crdtTypes/yArray.js";
import { EgWalkerError } from "../egWalker.js";
import {
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
  MAP_SET_OP,
  Op,
} from "../../eventGraph/eventGraph.js";

describe("EgWalker extended coverage", () => {
  it("should gracefully no-op when applying map-set to a YArray", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const arr = new YArray(doc, ["my-array"]);
    doc.getMap()._applySet("my-array", arr);

    const op = {
      type: MAP_SET_OP,
      path: ["my-array"],
      key: "foo",
      value: "bar",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => walker.localOp(op as any)).not.toThrow();
  });

  it("should gracefully no-op when applying array-insert to a YMap", () => {
    const doc = new Doc();
    const walker = doc.egWalker;

    const op = { type: ARRAY_INSERT_OP, path: [], index: 0, values: ["a"] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => walker.localOp(op as any)).not.toThrow();
  });

  it("should gracefully no-op when applying array-delete to a YMap", () => {
    const doc = new Doc();
    const walker = doc.egWalker;

    const op = { type: ARRAY_DELETE_OP, path: [], index: 0, length: 1 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => walker.localOp(op as any)).not.toThrow();
  });



  it("should gracefully no-op when path traverses into non-existent array index", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const arr = new YArray(doc, ["my-array"]);
    doc.getMap()._applySet("my-array", arr);

    const op = {
      type: ARRAY_INSERT_OP,
      path: ["my-array", 0],
      index: 0,
      values: ["a"],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => walker.localOp(op as any)).not.toThrow();
  });

  it("should handle event that already exists", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const event = walker.localOp({
      type: MAP_SET_OP,
      path: [],
      key: "foo",
      value: "bar",
    });
    walker.integrateRemote([event]); // should not throw
    expect(doc.getMap().get("foo")).toBe("bar");
  });

  it("should update sequence number from remote event", () => {
    const doc1 = new Doc();
    const doc2 = new Doc();

    // Manually set replicaId to be the same for both docs
    const replicaId = "shared-replica";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc1.egWalker as any).replicaId = replicaId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc2.egWalker as any).replicaId = replicaId;

    // doc1 generates an event
    doc1.getMap().set("key", "value1");

    // doc2 generates an event with a higher sequence number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc2.egWalker as any).sequenceNumber = 5;
    const remoteEvent = doc2.egWalker.localOp({
      type: MAP_SET_OP,
      path: [],
      key: "foo",
      value: "bar",
    });

    // doc1 integrates the remote event
    doc1.egWalker.integrateRemote([remoteEvent]);

    // Check if doc1's sequence number has been updated
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((doc1.egWalker as any).sequenceNumber).toBe(6);
  });

  it("should create intermediate YMaps in the path", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    const op: Op = {
      type: MAP_SET_OP,
      path: ["a", "b"],
      key: "foo",
      value: "bar",
    };
    walker.localOp(op);
    const mapA = doc.getMap().get("a") as YMap;
    expect(mapA).toBeInstanceOf(YMap);
    const mapB = mapA.get("b") as YMap;
    expect(mapB).toBeInstanceOf(YMap);
    expect(mapB.get("foo")).toBe("bar");
  });

  it("should dynamically create container when path contains a primitive without eventId", () => {
    const doc = new Doc();
    const walker = doc.egWalker;
    doc.getMap()._applySet("a", 123); // 'a' is a primitive, not a YMap/YArray/YText
    const op: Op = {
      type: MAP_SET_OP,
      path: ["a", "b"],
      key: "foo",
      value: "bar",
    };
    expect(() => walker.localOp(op)).not.toThrow();
    const mapA = doc.getMap().get("a");
    expect(mapA).toBeInstanceOf(YMap);
  });
});
