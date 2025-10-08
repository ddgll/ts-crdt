import { describe, it, expect } from 'vitest';
import { Doc } from '../../crdtTypes/Doc';

describe('Awareness / Presence', () => {
  it('should set and get awareness state', () => {
    const doc = new Doc('replicaA');
    const walker = doc.egWalker;

    const awarenessState = { cursor: { x: 10, y: 20 }, user: 'Alice' };
    walker.setAwareness(awarenessState);

    const retrievedState = walker.getAwareness('replicaA');
    expect(retrievedState).toEqual(awarenessState);
  });

  it('should return undefined for a replica with no awareness state', () => {
    const doc = new Doc('replicaA');
    const walker = doc.egWalker;

    const retrievedState = walker.getAwareness('replicaB');
    expect(retrievedState).toBeUndefined();
  });
});