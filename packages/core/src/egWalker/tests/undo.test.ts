import { describe, it, expect } from 'vitest';
import { Doc } from '../../crdtTypes/Doc';
import { UndoManager } from '../UndoManager';

describe('Undo/Redo Management', () => {
  it('should undo and redo a change', () => {
    const doc = new Doc();
    const undoManager = new UndoManager(doc.egWalker);
    const map = doc.getMap();

    // Initial state
    undoManager.track();

    // First change
    map.set('key1', 'value1');
    undoManager.track();

    // Second change
    map.set('key2', 'value2');
    undoManager.track();

    expect(doc.getMap().get('key2')).toBe('value2');

    // Undo the second change
    undoManager.undo();
    expect(doc.getMap().get('key2')).toBeUndefined();
    expect(doc.getMap().get('key1')).toBe('value1');

    // Redo the second change
    undoManager.redo();
    expect(doc.getMap().get('key2')).toBe('value2');
    expect(doc.getMap().get('key1')).toBe('value1');

    // Undo twice
    undoManager.undo();
    undoManager.undo();
    expect(doc.getMap().get('key1')).toBeUndefined();
    expect(doc.getMap().get('key2')).toBeUndefined();
  });
});