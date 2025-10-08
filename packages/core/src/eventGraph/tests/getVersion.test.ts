import {
  CrdtEvent,
  createEventGraph,
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
} from "../eventGraph.js";

const path = ["items"];

test("EventGraph.getVersion - get version", () => {
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
  graph.addEvent(event1);
  graph.addEvent(event2);
  expect(graph.getVersion()).toEqual(["2"]);
});

test("EventGraph.getVersion - get version with multiple branches", () => {
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
    parents: ["1"],
    op: { type: ARRAY_INSERT_OP, path, index: 1, values: ["c"] },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  graph.addEvent(event3);
  expect(graph.getVersion().sort()).toEqual(["2", "3"].sort());
});

test("EventGraph.getVersion - get version with delete operation", () => {
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
    op: { type: ARRAY_DELETE_OP, path, index: 0, length: 1 },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  expect(graph.getVersion()).toEqual(["2"]);
});

test("EventGraph.getVersion - get version with no events", () => {
  const graph = createEventGraph();
  expect(graph.getVersion()).toEqual([]);
});