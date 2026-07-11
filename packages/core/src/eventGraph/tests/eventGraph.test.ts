import { describe, it, expect } from 'vitest';
import {
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
  CrdtEvent,
  createEventGraph,
  EventGraphError,
  isCrdtEvent,
  MAP_SET_OP,
} from "../eventGraph.js";

describe("eventGraph", () => {

  it("should throw an error for an invalid operation type", () => {
    const eventGraph = createEventGraph();
    const event = {
      id: "1",
      replicaId: "A",
      parents: [],
      op: {
        type: "INVALID_OP",
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => eventGraph.addEvent(event as any)).toThrow(
      new EventGraphError("Invalid operation type"),
    );
  });

  it("should throw an error when an event references itself as a parent", () => {
    const eventGraph = createEventGraph();
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: ["A:1"], // Self-reference
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    // Self-referencing parents are caught by the "Invalid parent" check since
    // the event hasn't been added yet, so its own ID isn't in the graph.
    expect(() => eventGraph.addEvent(eventA)).toThrow(
      new EventGraphError("Invalid parent"),
    );
  });

  describe("isCrdtEvent", () => {
    it("should return true for a valid map set op", () => {
      const event: CrdtEvent = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return true for a valid array insert op", () => {
      const event: CrdtEvent = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP, path: [], afterId: null, values: [1] },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return true for a valid array delete op", () => {
      const event: CrdtEvent = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_DELETE_OP, path: [], targetIds: ["A:0"] },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return false for invalid map set op", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, key: 123 },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for invalid array insert op (values)", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP, afterId: null, values: "not-an-array" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for unknown op type", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: "unknown" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });

    it("should return false for malformed event IDs", () => {
      const baseEvent = {
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
      };
      
      expect(isCrdtEvent({ ...baseEvent, id: "foo" })).toBe(false);
      expect(isCrdtEvent({ ...baseEvent, id: "foo:" })).toBe(false);
      expect(isCrdtEvent({ ...baseEvent, id: ":123" })).toBe(false);
      expect(isCrdtEvent({ ...baseEvent, id: "foo:bar" })).toBe(false);
    });

    it("should return false for malformed parent IDs", () => {
      const event = {
        id: "A:2",
        replicaId: "A",
        parents: ["foo"],
        op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });

    // Security path tests
    it("should return false for object-typed path segments", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [{}], key: "a", value: 1 },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    
    it("should return false for map-set with __proto__ key", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [], key: "__proto__", value: {} },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });

    it("should return false for map-delete with constructor key", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: "map-delete", path: [], key: "constructor" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });

    it("should return true for valid paths", () => {
      const event = {
        id: "A:1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: ["content", 0, "text"], key: "a", value: 1 },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
  });

  describe("topologicalSort", () => {
    it("should correctly sort parents with sequence numbers > 9", () => {
      const eventGraph = createEventGraph();

      // Create a graph:
      // A:1 (root)
      // A:2 (child of A:1)
      // A:9 (child of A:1)
      // A:10 (child of A:9)
      // B:1 (merges A:10 and A:2)

      const eA1: CrdtEvent = { id: "A:1", replicaId: "A", parents: [], op: { type: MAP_SET_OP, path: [], key: "a", value: 1 } };
      const eA2: CrdtEvent = { id: "A:2", replicaId: "A", parents: ["A:1"], op: { type: MAP_SET_OP, path: [], key: "a", value: 2 } };
      const eA9: CrdtEvent = { id: "A:9", replicaId: "A", parents: ["A:1"], op: { type: MAP_SET_OP, path: [], key: "a", value: 9 } };
      const eA10: CrdtEvent = { id: "A:10", replicaId: "A", parents: ["A:9"], op: { type: MAP_SET_OP, path: [], key: "a", value: 10 } };
      const eB1: CrdtEvent = { id: "B:1", replicaId: "B", parents: ["A:10", "A:2"], op: { type: MAP_SET_OP, path: [], key: "a", value: 99 } };

      eventGraph.addEvent(eA1);
      eventGraph.addEvent(eA2);
      eventGraph.addEvent(eA9);
      eventGraph.addEvent(eA10);
      eventGraph.addEvent(eB1);

      const sorted = eventGraph.topologicalSort(eventGraph.getAllEvents());
      const sortedIds = sorted.map((e) => e.id);

      expect(sortedIds).toEqual(["A:1", "A:2", "A:9", "A:10", "B:1"]);
    });
  });
});
