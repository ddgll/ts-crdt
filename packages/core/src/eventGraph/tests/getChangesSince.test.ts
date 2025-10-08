import { describe, it, expect } from 'vitest';
import { createEventGraph, MAP_SET_OP } from '../eventGraph';

describe('getChangesSince', () => {
  it('should return all events since a given version', () => {
    const graph = createEventGraph();
    const eventA = { id: 'A:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    const eventB = { id: 'B:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventA);
    graph.addEvent(eventB);

    const eventC = { id: 'A:2', parents: [eventA.id, eventB.id], op: { type: MAP_SET_OP, path: [], key: 'c', value: 1 } };
    graph.addEvent(eventC);

    const eventD = { id: 'B:2', parents: [eventC.id], op: { type: MAP_SET_OP, path: [], key: 'd', value: 1 } };
    graph.addEvent(eventD);

    const version = [eventA.id, eventB.id];
    const changes = graph.getChangesSince(version);

    const changeIds = changes.map(c => c.id).sort();
    expect(changeIds).toEqual(['A:2', 'B:2']);
  });

  it('should return all events if the version is empty', () => {
    const graph = createEventGraph();
    const eventA = { id: 'A:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    const eventB = { id: 'B:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'b', value: 1 } };
    graph.addEvent(eventA);
    graph.addEvent(eventB);

    const changes = graph.getChangesSince([]);
    const changeIds = changes.map(c => c.id).sort();
    expect(changeIds).toEqual(['A:1', 'B:1']);
  });

  it('should return no events if the version is current', () => {
    const graph = createEventGraph();
    const eventA = { id: 'A:1', parents: [], op: { type: MAP_SET_OP, path: [], key: 'a', value: 1 } };
    graph.addEvent(eventA);

    const changes = graph.getChangesSince(graph.getVersion());
    expect(changes).toEqual([]);
  });
});