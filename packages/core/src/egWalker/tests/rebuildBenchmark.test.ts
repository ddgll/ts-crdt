import { describe, it, expect } from 'vitest';
import { Doc } from "../../crdtTypes/doc.js";

describe('Performance Benchmarks', () => {
  it('should efficiently rebuild the event graph state for 10000 events', () => {
    const doc = new Doc("replica-1");
    const eventCount = 100000;

    for (let i = 0; i < eventCount; i++) {
      doc.localInsert(["bench-array"], i, [`item-${i}`]);
    }
    const version = doc.egWalker.getVersion();
    
    const startTimeRebuild = performance.now();
    doc.egWalker.rebuildStateAtVersion(version);
    const endTimeRebuild = performance.now();
    
    const duration = endTimeRebuild - startTimeRebuild;

    // Ensure the state is correct
    const array = doc.getMap().getArray("bench-array");
    expect(array.toJSON().length).toBe(eventCount);
    
    // Ensure it runs in a reasonable time (500 ms max threshold for sanity)
    expect(duration).toBeLessThan(500);
  });
});
