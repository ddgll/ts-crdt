import { describe, it, expect } from 'vitest';
import { createEventGraph, MAP_SET_OP } from '../eventGraph';

describe('Version Management', () => {
  it('should get the last critical version', () => {
    const graph = createEventGraph();

    const eventA = { id: 'A:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(eventA);
    const criticalVersion1 = graph.getVersion();

    const eventB = { id: 'B:1', parents: [eventA.id], op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventB);

    const eventC = { id: 'C:1', parents: [eventA.id], op: { type: MAP_SET_OP, path: [], key: 'c', value: 1 } };
    graph.addEvent(eventC);

    const eventD = { id: 'D:1', parents: [eventB.id, eventC.id], op: { type: MAP_SET_OP, path: [], key: 'd', value: 1 } };
    graph.addEvent(eventD);

    const lastCriticalVersion = graph.getLastCriticalVersion();
    expect(lastCriticalVersion).toEqual(criticalVersion1);
  });

  it('should return an empty array if no critical version exists', () => {
    const graph = createEventGraph();
    const eventA = { id: 'A:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(eventA);
    const eventB = { id: 'B:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventB);

    const lastCriticalVersion = graph.getLastCriticalVersion();
    expect(lastCriticalVersion).toEqual([]);
  });
});