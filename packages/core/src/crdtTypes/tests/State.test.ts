import { describe, it, expect } from 'vitest';
import { Doc } from '../Doc';

describe('CRDT State Management', () => {
  it('should initialize a new document with a clean state', () => {
    const doc = new Doc();
    // A new doc should have a root map, but it should be empty.
    expect(doc.getMap().toJSON()).toEqual({});
    // The event graph should be initialized but have no events,
    // and the sequence number should be 0.
    const snapshot = doc.egWalker.getStateSnapshot();
    expect(snapshot.graph.events.length).toBe(0);
    expect(snapshot.sequenceNumber).toBe(0);
  });

  it('should have an empty version for a new document', () => {
    const doc = new Doc();
    const map = doc.getMap();
    const event = map.set('key', 'value');
    expect(event.parents).toEqual([]);
  });

  it('should clear the document state', () => {
    const doc = new Doc();
    const map = doc.getMap();
    map.set('key', 'value');

    doc.clear();

    const snapshot = doc.egWalker.getStateSnapshot();
    expect(snapshot.graph.events.length).toBe(0);
    expect(snapshot.sequenceNumber).toBe(0);
    expect(doc.getMap().toJSON()).toEqual({});
  });
});