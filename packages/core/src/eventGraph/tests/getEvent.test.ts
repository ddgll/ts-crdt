import {
  CrdtEvent,
  createEventGraph,
  ARRAY_DELETE_OP,
  ARRAY_INSERT_OP,
} from "../eventGraph.js";

const path = ["items"];

test("EventGraph.getEvent - get event", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  graph.addEvent(event);
  expect(graph.getEvent("1")).toEqual(event);
});

test("EventGraph.getEvent - get non-existent event", () => {
  const graph = createEventGraph();
  expect(graph.getEvent("non-existent")).toBeUndefined();
});

test("EventGraph.getEvent - get event after adding multiple events", () => {
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
  expect(graph.getEvent("1")).toEqual(event1);
  expect(graph.getEvent("2")).toEqual(event2);
});

test("EventGraph.getEvent - get event with multiple parents", () => {
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
  expect(graph.getEvent("3")).toEqual(event3);
});

test("EventGraph.getEvent - get delete event", () => {
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
  expect(graph.getEvent("2")).toEqual(event2);
});

test("EventGraph.getEvent - get duplicate event", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  graph.addEvent(event);
  graph.addEvent(event);
  expect(graph.getEvent("1")).toEqual(event);
});