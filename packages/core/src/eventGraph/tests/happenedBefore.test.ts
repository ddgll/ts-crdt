import { describe, expect, it } from "vitest";
import { CrdtEvent, createEventGraph, MAP_SET_OP } from "../eventGraph.js";

describe("happenedBefore", () => {
  it("should return true if a is a direct parent of b", () => {
    const eventGraph = createEventGraph();
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    eventGraph.addEvent(eventA);
    const eventB: CrdtEvent = {
      id: "B:1",
      replicaId: "B",
      parents: ["A:1"],
      op: { type: MAP_SET_OP, path: [], key: "b", value: 2 },
    };
    eventGraph.addEvent(eventB);
    expect(eventGraph.happenedBefore(eventA, eventB)).toBe(true);
  });

  it("should return true if a is an indirect parent of b", () => {
    const eventGraph = createEventGraph();
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    eventGraph.addEvent(eventA);
    const eventB: CrdtEvent = {
      id: "B:1",
      replicaId: "B",
      parents: ["A:1"],
      op: { type: MAP_SET_OP, path: [], key: "b", value: 2 },
    };
    eventGraph.addEvent(eventB);
    const eventC: CrdtEvent = {
      id: "C:1",
      replicaId: "C",
      parents: ["B:1"],
      op: { type: MAP_SET_OP, path: [], key: "c", value: 3 },
    };
    eventGraph.addEvent(eventC);
    expect(eventGraph.happenedBefore(eventA, eventC)).toBe(true);
  });

  it("should return false if a is not a parent of b", () => {
    const eventGraph = createEventGraph();
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    eventGraph.addEvent(eventA);
    const eventB: CrdtEvent = {
      id: "B:1",
      replicaId: "B",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "b", value: 2 },
    };
    eventGraph.addEvent(eventB);
    expect(eventGraph.happenedBefore(eventA, eventB)).toBe(false);
  });

  it("should return true for the same event", () => {
    const eventGraph = createEventGraph();
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    eventGraph.addEvent(eventA);
    expect(eventGraph.happenedBefore(eventA, eventA)).toBe(true);
  });

  it("should handle complex graphs with redundant paths", () => {
    const eventGraph = createEventGraph();
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    eventGraph.addEvent(eventA);
    const eventB: CrdtEvent = {
      id: "B:1",
      replicaId: "B",
      parents: ["A:1"],
      op: { type: MAP_SET_OP, path: [], key: "b", value: 2 },
    };
    eventGraph.addEvent(eventB);
    const eventC: CrdtEvent = {
      id: "C:1",
      replicaId: "C",
      parents: ["A:1"],
      op: { type: MAP_SET_OP, path: [], key: "c", value: 3 },
    };
    eventGraph.addEvent(eventC);
    const eventD: CrdtEvent = {
      id: "D:1",
      replicaId: "D",
      parents: ["B:1", "C:1"],
      op: { type: MAP_SET_OP, path: [], key: "d", value: 4 },
    };
    eventGraph.addEvent(eventD);

    expect(eventGraph.happenedBefore(eventA, eventD)).toBe(true);
    expect(eventGraph.happenedBefore(eventD, eventA)).toBe(false);
  });
});
