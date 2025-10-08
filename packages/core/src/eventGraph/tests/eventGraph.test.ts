import { describe, it, expect } from "vitest";
import {
  createEventGraph,
  EventGraphError,
  isCrdtEvent,
  MAP_SET_OP,
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
  ARRAY_REPLACE_OP,
  CrdtEvent,
} from "../eventGraph.js";

describe("eventGraph", () => {
  it("should throw an error for an array delete operation with a negative length", () => {
    const eventGraph = createEventGraph();
    const event: CrdtEvent = {
      id: "1",
      replicaId: "A",
      parents: [],
      op: {
        type: ARRAY_DELETE_OP,
        path: [],
        index: 0,
        length: -1,
      },
    };
    expect(() => eventGraph.addEvent(event)).toThrow(
      new EventGraphError("Invalid index or length")
    );
  });

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
      new EventGraphError("Invalid operation type")
    );
  });

  it("should throw an error for a circular dependency", () => {
    const eventGraph = createEventGraph(false);
    const eventA: CrdtEvent = {
      id: "A:1",
      replicaId: "A",
      parents: [],
      op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
    };
    eventGraph.addEvent(eventA);
    const eventB: CrdtEvent = {
      id: "A:2",
      replicaId: "A",
      parents: ["A:1"],
      op: { type: MAP_SET_OP, path: [], key: "b", value: 2 },
    };
    eventGraph.addEvent(eventB);
    eventA.parents.push("A:2"); // Create circular dependency
    expect(() => eventGraph.addEvent(eventA)).toThrow(
      new EventGraphError("Invalid circular dependency")
    );
  });

  describe("isCrdtEvent", () => {
    it("should return true for a valid map set op", () => {
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [], key: "a", value: 1 },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return true for a valid array insert op", () => {
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP, path: [], index: 0, values: [1] },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return true for a valid array delete op", () => {
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_DELETE_OP, path: [], index: 0, length: 1 },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return true for a valid array replace op", () => {
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_REPLACE_OP, path: [], values: [1] },
      };
      expect(isCrdtEvent(event)).toBe(true);
    });
    it("should return false for invalid map set op", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, key: 123 },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for invalid array insert op (index)", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP, index: "a", values: [] },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for invalid array insert op (values)", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP, index: 0, values: "not-an-array" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for invalid array delete op (index)", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_DELETE_OP, index: "a", length: 1 },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for invalid array delete op (length)", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_DELETE_OP, index: 0, length: "a" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for invalid array replace op", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_REPLACE_OP, values: "not-an-array" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
    it("should return false for unknown op type", () => {
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: "unknown" },
      };
      expect(isCrdtEvent(event)).toBe(false);
    });
  });
});