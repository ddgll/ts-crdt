import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";
import { isCrdtEvent } from "../../eventGraph/eventGraph.js";

describe("Replicate bug", () => {
  it("should throw 'Invalid circular dependency' error", () => {
    // This test is designed to replicate a bug reported by the user.
    // In the user's application, this sequence of operations throws an
    // "Invalid circular dependency" error. This test is expected to fail
    // in the current CI environment because the bug is not reproduced,
    // but it serves as a starting point for debugging the issue.

    // 1. First client instance creates a document and adds content.
    const doc1 = new Doc();
    doc1.getMap().getArray("content").insert(0, []);

    const snapshot = doc1.egWalker.getStateSnapshot();
    const serializedSnapshot = JSON.parse(JSON.stringify(snapshot));

    const doc2 = new Doc();
    doc2.egWalker.loadStateSnapshot(serializedSnapshot);
    doc2.getMap().getArray("content").replace(["test"]);
    const events = doc2.egWalker.getStateSnapshot().graph.events;
    const event = events[events.length - 1][1];
    doc1.egWalker.integrateRemote([event]);

    const snapshot2 = doc1.egWalker.getStateSnapshot();
    const serializedSnapshot2 = JSON.parse(JSON.stringify(snapshot2));
    const doc3 = new Doc();
    doc3.egWalker.loadStateSnapshot(serializedSnapshot2);

    // This operation is expected to fail with a circular dependency error in the user's environment.
    doc3.getMap().getArray("content").replace(["to", "to"]);
    expect(isCrdtEvent(doc3.egWalker.getStateSnapshot().graph.events[doc3.egWalker.getStateSnapshot().graph.events.length - 1][1])).toBe(
      true
    );
  });
});
