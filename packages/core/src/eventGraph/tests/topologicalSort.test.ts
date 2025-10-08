import {
  CrdtEvent,
  createEventGraph,
  ARRAY_INSERT_OP,
  Op,
} from "../eventGraph.js";

const path = ["items"];

test("EventGraph.topologicalSort - topological sort", () => {
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

  const sorted: CrdtEvent[] = graph.topologicalSort(graph.getEvents(graph.getVersion()));
  expect(sorted.length).toBe(3);
  const index1 = sorted.findIndex((e) => e.id === "1");
  const index2 = sorted.findIndex((e) => e.id === "2");
  const index3 = sorted.findIndex((e) => e.id === "3");
  expect(index1).toBeLessThan(index2);
  expect(index1).toBeLessThan(index3);
});

test("EventGraph.topologicalSort - no events", () => {
  const graph = createEventGraph();
  const sorted: CrdtEvent[] = graph.topologicalSort([]);
  expect(sorted.length).toBe(0);
});

test("EventGraph.topologicalSort - single event", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] },
  };
  graph.addEvent(event);
  const sorted: CrdtEvent[] = graph.topologicalSort([event]);
  expect(sorted.length).toBe(1);
  expect(sorted[0].id).toBe("1");
});

test("EventGraph.topologicalSort - multiple independent events", () => {
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
  const sorted: CrdtEvent[] = graph.topologicalSort([event1, event2]);
  expect(sorted.length).toBe(2);
  expect(sorted.map((e) => e.id).sort()).toEqual(["1", "2"]);
});

test("EventGraph.topologicalSort - event with multiple parents", () => {
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
  const sorted: CrdtEvent[] = graph.topologicalSort(graph.getEvents(graph.getVersion()));
  expect(sorted.length).toBe(3);
  const index1 = sorted.findIndex((e) => e.id === "1");
  const index2 = sorted.findIndex((e) => e.id === "2");
  const index3 = sorted.findIndex((e) => e.id === "3");
  expect(index1).toBeLessThan(index2);
  expect(index2).toBeLessThan(index3);
});

test("EventGraph.topologicalSort - non-existent event", () => {
  const graph = createEventGraph();
  const sorted: CrdtEvent[] = graph.topologicalSort([{
    id: "non-existent",
    replicaId: "r1",
    parents: [],
    op: { type: ARRAY_INSERT_OP, path, index: 0, values: ["a"] } as Op,
  }]);
  expect(sorted.length).toBe(0);
});