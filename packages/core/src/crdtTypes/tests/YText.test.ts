import { describe, it, expect } from 'vitest';
import { Doc } from '../Doc';
import { TextFormatOperation } from '../../eventGraph/eventGraph';

describe('YText', () => {
  it('should insert text and apply formatting', () => {
    const doc = new Doc();
    const text = doc.getMap().getText('myText');

    text.insert(0, 'Hello World');
    expect(text.toString()).toBe('Hello World');

    // Apply bold formatting to "Hello"
    text.format(0, 5, { bold: true });

    // This is a simplified representation. A real implementation would
    // have a more complex way to retrieve formatted content.
    const formattingEvents = doc.egWalker.getStateSnapshot().graph.events.filter(
      ([_, event]) => event.op.type === 'text-format'
    );

    expect(formattingEvents.length).toBe(1);
    const formatOp = formattingEvents[0][1].op as TextFormatOperation;
    expect(formatOp.index).toBe(0);
    expect(formatOp.length).toBe(5);
    expect(formatOp.attributes).toEqual({ bold: true });
  });
});