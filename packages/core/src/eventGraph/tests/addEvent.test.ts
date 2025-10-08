import {
  CrdtEvent,
  createEventGraph,
  EventGraphError,
  MAP_SET_OP,
  ARRAY_INSERT_OP,
  ARRAY_DELETE_OP,
  Op,
} from "../eventGraph.js";

const path = ["items"];

test("EventGraph.addEvent - add event", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 0,
      values: ["a"],
    },
  };
  graph.addEvent(event);
  expect(graph.getEvent("1")).toEqual(event);
});

test("EventGraph.addEvent - add multiple events", () => {
  const graph = createEventGraph();
  const event1: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 0,
      values: ["a"],
    },
  };
  const event2: CrdtEvent = {
    id: "2",
    replicaId: "r1",
    parents: ["1"],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 1,
      values: ["b"],
    },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  expect(graph.getEvent("1")).toEqual(event1);
  expect(graph.getEvent("2")).toEqual(event2);
});

test("EventGraph.addEvent - add event with multiple parents", () => {
  const graph = createEventGraph();
  const event1: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 0,
      values: ["a"],
    },
  };
  const event2: CrdtEvent = {
    id: "2",
    replicaId: "r1",
    parents: ["1"],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 1,
      values: ["b"],
    },
  };
  const event3: CrdtEvent = {
    id: "3",
    replicaId: "r2",
    parents: ["1", "2"],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 2,
      values: ["c"],
    },
  };
  graph.addEvent(event1);
  graph.addEvent(event2);
  graph.addEvent(event3);
  expect(graph.getEvent("3")).toEqual(event3);
});

test("EventGraph.addEvent - add delete event", () => {
  const graph = createEventGraph();
  const event1: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 0,
      values: ["a"],
    },
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

test("EventGraph.addEvent - add event with non-existent parent", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: ["non-existent"],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 0,
      values: ["a"],
    },
  };
  expect(() => graph.addEvent(event)).toThrow(new EventGraphError("Invalid parent"));
});

test("EventGraph.addEvent - add duplicate event", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: ARRAY_INSERT_OP,
      path,
      index: 0,
      values: ["a"],
    },
  };
  graph.addEvent(event);
  graph.addEvent(event); // should not throw, just overwrite
  expect(graph.getEvent("1")).toEqual(event);
});

test("EventGraph.addEvent - add event with invalid operation", () => {
  const graph = createEventGraph();
  const event: CrdtEvent = {
    id: "1",
    replicaId: "r1",
    parents: [],
    op: {
      type: "invalid",
      path,
    } as unknown as Op,
  };
  expect(() => graph.addEvent(event)).toThrow(new EventGraphError("Invalid operation type"));
});

test("EventGraph.addEvent - add map set event", () => {
    const graph = createEventGraph();
    const event: CrdtEvent = {
      id: "1",
      replicaId: "r1",
      parents: [],
      op: {
        type: MAP_SET_OP,
        path,
        key: "foo",
        value: "bar",
      },
    };
    graph.addEvent(event);
    expect(graph.getEvent("1")).toEqual(event);
});