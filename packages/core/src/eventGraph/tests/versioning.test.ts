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
});