import { describe, expect, it } from "vitest";
import {
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
  ARRAY_REPLACE_OP,
  CrdtEvent,
  createEventGraph,
  EventGraphError,
  isCrdtEvent,
  MAP_SET_OP,
} from "../eventGraph.js";

describe("eventGraph extended coverage", () => {
  describe("isCrdtEvent", () => {
    it("should return false for non-object events", () => {
      expect(isCrdtEvent(null)).toBe(false);
      expect(isCrdtEvent(undefined)).toBe(false);
      expect(isCrdtEvent(123)).toBe(false);
      expect(isCrdtEvent("event")).toBe(false);
    });

    it("should return false for events with missing properties", () => {
      expect(isCrdtEvent({})).toBe(false);
      expect(isCrdtEvent({ id: "1" })).toBe(false);
      expect(isCrdtEvent({ id: "1", replicaId: "A" })).toBe(false);
      expect(isCrdtEvent({ id: "1", replicaId: "A", parents: [] })).toBe(false);
    });

    it("should return false for events with invalid property types", () => {
      expect(isCrdtEvent({ id: 1, replicaId: "A", parents: [], op: {} })).toBe(
        false
      );
      expect(isCrdtEvent({ id: "1", replicaId: 1, parents: [], op: {} })).toBe(
        false
      );
      expect(
        isCrdtEvent({ id: "1", replicaId: "A", parents: "[]", op: {} })
      ).toBe(false);
      expect(
        isCrdtEvent({ id: "1", replicaId: "A", parents: [1], op: {} })
      ).toBe(false);
      expect(
        isCrdtEvent({ id: "1", replicaId: "A", parents: [], op: null })
      ).toBe(false);
    });

    it("should return false for invalid op types", () => {
      const baseEvent = { id: "1", replicaId: "A", parents: [] };
      expect(isCrdtEvent({ ...baseEvent, op: { type: "INVALID_OP" } })).toBe(
        false
      );
    });

    it("should return false for MAP_SET_OP with invalid properties", () => {
      const baseEvent = { id: "1", replicaId: "A", parents: [] };
      expect(isCrdtEvent({ ...baseEvent, op: { type: MAP_SET_OP } })).toBe(
        false
      ); // missing key
      expect(
        isCrdtEvent({ ...baseEvent, op: { type: MAP_SET_OP, key: 123 } })
      ).toBe(false); // key is not a string
    });

    it("should return false for ARRAY_INSERT_OP with invalid properties", () => {
      const baseEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP },
      };
      expect(
        isCrdtEvent({ ...baseEvent, op: { ...baseEvent.op, index: "0" } })
      ).toBe(false);
      expect(
        isCrdtEvent({
          ...baseEvent,
          op: { ...baseEvent.op, index: 0, values: "not-an-array" },
        })
      ).toBe(false);
    });

    it("should return false for ARRAY_DELETE_OP with invalid properties", () => {
      const baseEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_DELETE_OP },
      };
      expect(
        isCrdtEvent({ ...baseEvent, op: { ...baseEvent.op, index: "0" } })
      ).toBe(false);
      expect(
        isCrdtEvent({
          ...baseEvent,
          op: { ...baseEvent.op, index: 0, length: "1" },
        })
      ).toBe(false);
    });

    it("should return false for ARRAY_REPLACE_OP with invalid properties", () => {
      const baseEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_REPLACE_OP },
      };
      expect(
        isCrdtEvent({
          ...baseEvent,
          op: { ...baseEvent.op, values: "not-an-array" },
        })
      ).toBe(false);
    });
  });

  describe("addEvent error conditions", () => {
    it("should throw for invalid array op indices", () => {
      const graph = createEventGraph();
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_INSERT_OP, path: [], index: -1, values: [] },
      };
      expect(() => graph.addEvent(event)).toThrow(
        new EventGraphError("Invalid index")
      );
    });

    it("should throw for invalid array delete length", () => {
      const graph = createEventGraph();
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: ARRAY_DELETE_OP, path: [], index: 0, length: -1 },
      };
      expect(() => graph.addEvent(event)).toThrow(
        new EventGraphError("Invalid index or length")
      );
    });

    it("should throw for invalid operation type", () => {
      const graph = createEventGraph();
      const event = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: "INVALID_OP" },
      } as unknown as CrdtEvent;
      expect(() => graph.addEvent(event)).toThrow(
        new EventGraphError("Invalid operation type")
      );
    });

    it("should throw when an event is its own parent", () => {
      const graph = createEventGraph();
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: ["1"],
        op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
      };
      expect(() => graph.addEvent(event)).toThrow(
        new EventGraphError("Invalid parent")
      );
    });
  });

  describe("isCriticalVersion", () => {
    it("should return false for empty graph", () => {
      const graph = createEventGraph();
      expect(graph.isCriticalVersion([])).toBe(false);
    });

    it("should return false for non-matching versions", () => {
      const graph = createEventGraph();
      graph.addEvent({
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
      });
      expect(graph.isCriticalVersion(["2"])).toBe(false);
    });
  });

  describe("topologicalSort", () => {
    it("should handle events not in the graph", () => {
      const graph = createEventGraph();
      const event: CrdtEvent = {
        id: "1",
        replicaId: "A",
        parents: [],
        op: { type: MAP_SET_OP, path: [], key: "foo", value: "bar" },
      };
      expect(graph.topologicalSort([event])).toEqual([]);
    });
  });
});
