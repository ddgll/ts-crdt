import { describe, it, expect } from 'vitest';
import { Doc } from '../doc.js';
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
    expect(formatOp.targetIds.length).toBe(5);
    expect(formatOp.attributes).toEqual({ bold: true });
  });

  it('should break ties deterministically using sequence numbers (RGA)', () => {
    const docA = new Doc("replicaA");
    const docB = new Doc("replicaB");

    // Init with an anchor text
    docA.getMap().getText("myText").insert(0, "X");
    const eventsA0 = docA.egWalker.getStateSnapshot().graph.events.map(e => e[1]);
    docB.egWalker.integrateRemote(eventsA0);

    const anchorId = "replicaA:0:0";

    // Manually construct events with "replica:9" and "replica:10"
    const event9 = {
      id: "replica:9",
      replicaId: "replica",
      parents: ["replicaA:0"],
      op: {
        type: "text-insert" as const,
        path: ["myText"],
        afterId: anchorId,
        text: "A"
      }
    };

    const event10 = {
      id: "replica:10",
      replicaId: "replica",
      parents: ["replicaA:0"],
      op: {
        type: "text-insert" as const,
        path: ["myText"],
        afterId: anchorId,
        text: "B"
      }
    };

    docA.egWalker.integrateRemote([event9, event10]);
    docB.egWalker.integrateRemote([event10, event9]);

    expect(docA.getMap().getText("myText").toString()).toEqual(
      docB.getMap().getText("myText").toString()
    );
  });
});