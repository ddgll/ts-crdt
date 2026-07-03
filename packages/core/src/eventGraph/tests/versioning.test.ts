import { describe, it, expect } from 'vitest';
import { CrdtEvent, createEventGraph, MAP_SET_OP } from '../eventGraph';

describe('Version Management', () => {
  it('should get the last critical version', () => {
    const graph = createEventGraph();

    const eventA: CrdtEvent = { id: 'A:1', parents: [], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(eventA);

    const eventB: CrdtEvent = { id: 'B:1', parents: [eventA.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventB);

    const eventC: CrdtEvent = { id: 'C:1', parents: [eventA.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'c', value: 1 } };
    graph.addEvent(eventC);

    const eventD: CrdtEvent = { id: 'D:1', parents: [eventB.id, eventC.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'd', value: 1 } };
    graph.addEvent(eventD);

    const lastCriticalVersion = graph.getLastCriticalVersion();

    // D:1 is the actual critical version because it merges the branches
    expect(lastCriticalVersion).toEqual(['D:1']);
  });

  it('should return an empty array if no critical version exists', () => {
    const graph = createEventGraph();
    const eventA: CrdtEvent = { id: 'A:1', parents: [], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(eventA);
    const eventB: CrdtEvent = { id: 'B:1', parents: [], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventB);

    const lastCriticalVersion = graph.getLastCriticalVersion();
    expect(lastCriticalVersion).toEqual([]);
  });

  it('should return the correct critical version for unmerged branches', () => {
    const graph = createEventGraph();
    const root: CrdtEvent = { id: 'Root', parents: [], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(root);
    const eventA: CrdtEvent = { id: 'A', parents: [root.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(eventA);
    const eventB: CrdtEvent = { id: 'B', parents: [root.id], replicaId: "replica-2", op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventB);
    const eventC: CrdtEvent = { id: 'C', parents: [eventA.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'c', value: 1 } };
    graph.addEvent(eventC);

    const lastCriticalVersion = graph.getLastCriticalVersion();
    expect(lastCriticalVersion).toEqual(['Root']);
  });

  it('should not incorrectly identify a node with concurrent events as a critical version', () => {
    const graph = createEventGraph();
    const root: CrdtEvent = { id: 'Root', parents: [], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(root);
    const x: CrdtEvent = { id: 'X', parents: [root.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'x', value: 1 } };
    graph.addEvent(x);
    const y: CrdtEvent = { id: 'Y', parents: [root.id], replicaId: "replica-2", op: { type: MAP_SET_OP, path: [], key: 'y', value: 1 } };
    graph.addEvent(y);
    const h1: CrdtEvent = { id: 'H1', parents: [x.id], replicaId: "replica-1", op: { type: MAP_SET_OP, path: [], key: 'h1', value: 1 } };
    graph.addEvent(h1);
    const c: CrdtEvent = { id: 'C', parents: [x.id, y.id], replicaId: "replica-2", op: { type: MAP_SET_OP, path: [], key: 'c', value: 1 } };
    graph.addEvent(c);
    const h2: CrdtEvent = { id: 'H2', parents: [c.id], replicaId: "replica-2", op: { type: MAP_SET_OP, path: [], key: 'h2', value: 1 } };
    graph.addEvent(h2);

    const lastCriticalVersion = graph.getLastCriticalVersion();
    // X is an ancestor of both H1 and H2, but it had a concurrent event (Y). So Root is the only critical version.
    expect(lastCriticalVersion).toEqual(['Root']);
  });
});