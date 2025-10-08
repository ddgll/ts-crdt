import { describe, it, expect } from 'vitest';
import { Doc } from '../../crdtTypes/Doc';

describe('History Navigation', () => {
  it('should rebuild the document state to a specific version', () => {
    const doc = new Doc();
    const map = doc.getMap();

    map.set('key1', 'value1');
    const version1 = doc.egWalker.getStateSnapshot().graph.events.map(([id]) => id);
    const state1 = doc.toJSON();

    map.set('key2', 'value2');
    map.set('key1', 'updatedValue1');

    // Rebuild the state to the first version
    doc.egWalker.rebuildStateAtVersion(version1);
    const revertedState = doc.toJSON();

    expect(revertedState).toEqual(state1);

    const snapshot = doc.egWalker.getStateSnapshot();
    const currentVersion = snapshot.graph.events.map(([id]) => id);
    // Note: The event graph itself is not modified, only the document state.
    // So the current version of the graph should still contain all events.
    expect(currentVersion.length).toBe(3);
  });
});