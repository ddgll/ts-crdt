import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import {
  isCrdtEvent,
  MAX_EVENT_SEQUENCE,
} from "../../eventGraph/eventGraph.js";

/**
 * Regression tests for B4: a crafted event with an out-of-range Lamport sequence
 * must not be able to poison a replica's clock into saturating near
 * `Number.MAX_SAFE_INTEGER` (which makes `sequenceNumber++` stop advancing and
 * mint colliding ids, silently dropping the replica's own subsequent events).
 */
describe("clock-poisoning defenses", () => {
  it("bounds the sequence below the safe-integer ceiling", () => {
    expect(MAX_EVENT_SEQUENCE).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("rejects an event whose sequence exceeds the bound", () => {
    const poison = {
      id: `evil:${Number.MAX_SAFE_INTEGER}`,
      replicaId: "evil",
      parents: [],
      op: { type: "map-set", path: [], key: "k", value: 1 },
    };
    expect(isCrdtEvent(poison)).toBe(false);
  });

  it("rejects an event with an absurdly long sequence string", () => {
    const poison = {
      id: `evil:${"9".repeat(40)}`,
      replicaId: "evil",
      parents: [],
      op: { type: "map-set", path: [], key: "k", value: 1 },
    };
    expect(isCrdtEvent(poison)).toBe(false);
  });

  it("still accepts a normal event", () => {
    const ok = {
      id: "good:5",
      replicaId: "good",
      parents: [],
      op: { type: "map-set", path: [], key: "k", value: 1 },
    };
    expect(isCrdtEvent(ok)).toBe(true);
  });

  it("fails loudly instead of silently losing events when the clock is poisoned", () => {
    const doc = new Doc("victim");
    // A poison event slips in via a trusted peer-to-peer integrate (which does
    // not run the wire-level isCrdtEvent guard) and saturates the clock.
    doc.egWalker.integrateRemote([
      {
        id: `evil:${Number.MAX_SAFE_INTEGER}`,
        replicaId: "evil",
        parents: [],
        op: { type: "map-set", path: [], key: "x", value: 1 },
      },
    ]);

    const map = doc.getMap();
    expect(() => {
      map.set("a", 1);
      map.set("b", 2);
      map.set("c", 3);
    }).toThrow(/collision/i);
  });
});
