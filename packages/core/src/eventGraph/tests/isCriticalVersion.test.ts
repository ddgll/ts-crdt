import {
  CrdtEvent,
  createEventGraph,
  ARRAY_INSERT_OP,
} from "../eventGraph.js";

const path = ["items"];

test("EventGraph.isCriticalVersion - is critical version", () => {
  const graph = createEventGraph();
  const event1: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  const event2: CrdtEvent = {
    id: "2",
    replicaId: "r2",
    parents: ["1"],
    op: { type: ARRAY_INSERT_OP, path, index: 1, values: ["b"] },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  expect(graph.isCriticalVersion(["2"])).toBe(true);
  expect(graph.isCriticalVersion(["1"])).toBe(false);
});

test("EventGraph.isCriticalVersion - no events", () => {
  const graph = createEventGraph();
  expect(graph.isCriticalVersion([])).toBe(false);
});

test("EventGraph.isCriticalVersion - single event", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  graph.addEvent(event);
  expect(graph.isCriticalVersion(["1"])).toBe(true);
});

test("EventGraph.isCriticalVersion - multiple independent events", () => {
  const graph = createEventGraph();
  const event1: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  const event2: CrdtEvent = {
    id: "2",
    replicaId: "r2",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 1, values: ["b"] },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  const currentVersion = graph.getVersion();
  expect(currentVersion.sort()).toEqual(["1", "2"]);
  expect(graph.isCriticalVersion(currentVersion)).toBe(true);
});

test("EventGraph.isCriticalVersion - event with multiple parents", () => {
  const graph = createEventGraph();
  const event1: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  const event2: CrdtEvent = {
    id: "2",
    replicaId: "r1",
    parents: ["1"],
    op: { type: ARRAY_INSERT_OP, path, index: 1, values: ["b"] },
  };
  const event3: CrdtEvent = {
    id: "3",
    replicaId: "r2",
    parents: ["1", "2"],
    op: { type: ARRAY_INSERT_OP, path, index: 2, values: ["c"] },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  graph.addEvent(event3);
  expect(graph.isCriticalVersion(["3"])).toBe(true);
});

test("EventGraph.isCriticalVersion - non-existent event", () => {
  const graph = createEventGraph();
  expect(graph.isCriticalVersion(["non-existent"])).toBe(false);
});