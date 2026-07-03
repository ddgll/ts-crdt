import { describe, it, expect } from 'vitest';
import {
  CrdtEvent,
  createEventGraph,
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
} from "../eventGraph.js";

const path = ["items"];

describe("EventGraph.getEvents", () => {
  it("get events", () => {
    const graph = createEventGraph();
    const event1: CrdtEvent = {
      id: "1",
      replicaId: "r1",
      parents: [],
      op: { type: ARRAY_INSERT_OP, path, afterId: null, values: ["a"] },
    };
    const event2: CrdtEvent = {
      id: "2",
      replicaId: "r1",
      parents: ["1"],
      op: { type: ARRAY_INSERT_OP, path, afterId: "A:0", values: ["b"] },
    };
    graph.addEvent(event1);
    graph.addEvent(event2);
    const events: CrdtEvent[] = graph.getEvents(["2"]);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.id).sort()).toEqual(["1", "2"]);
  });

  it("get events with non-existent version", () => {
    const graph = createEventGraph();
    const events: CrdtEvent[] = graph.getEvents(["non-existent"]);
    expect(events.length).toBe(0);
  });

  it("get events with multiple versions", () => {
    const graph = createEventGraph();
    const event1: CrdtEvent = {
      id: "1",
      replicaId: "r1",
      parents: [],
      op: { type: ARRAY_INSERT_OP, path, afterId: null, values: ["a"] },
    };
    const event2: CrdtEvent = {
      id: "2",
      replicaId: "r1",
      parents: ["1"],
      op: { type: ARRAY_INSERT_OP, path, afterId: "A:0", values: ["b"] },
    };
    const event3: CrdtEvent = {
      id: "3",
      replicaId: "r2",
      parents: ["1"],
      op: { type: ARRAY_INSERT_OP, path, afterId: "A:0", values: ["c"] },
    };
    graph.addEvent(event1);
    graph.addEvent(event2);
    graph.addEvent(event3);
    const events: CrdtEvent[] = graph.getEvents(["2", "3"]);
    expect(events.length).toBe(3);
    expect(events.map((e) => e.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("get events with delete operation", () => {
    const graph = createEventGraph();
    const event1: CrdtEvent = {
      id: "1",
      replicaId: "r1",
      parents: [],
      op: { type: ARRAY_INSERT_OP, path, afterId: null, values: ["a"] },
    };
    const event2: CrdtEvent = {
      id: "2",
      replicaId: "r1",
      parents: ["1"],
      op: { type: ARRAY_DELETE_OP, path, afterId: null, targetIds: ["A:0"] },
    };
    graph.addEvent(event1);
    graph.addEvent(event2);
    const events: CrdtEvent[] = graph.getEvents(["2"]);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.id).sort()).toEqual(["1", "2"]);
  });
});