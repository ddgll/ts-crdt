import { describe, it, expect } from "vitest";
import { Doc } from "../doc.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

/**
 * Regression tests for B2: `Doc.gc()` must invalidate the walker's incremental
 * undo-closure cache. gc() splices tombstones out of a type's internal `_data`,
 * which invalidates the by-value indices captured in the undo closures. If the
 * cache is not cleared, a later concurrent event that sorts before a gc'd-past
 * event drives the incremental undo/redo path with a stale index, duplicating or
 * dropping elements and permanently diverging the replica from its own history.
 *
 * These also cover the cross-replica anchor-loss case that the right-origin (B1)
 * fix un-masks: with correct interior insertion, an insert anchored near a gc'd
 * region must still converge with a fresh replay of the same event graph.
 */
describe("Doc.gc() undo-cache invalidation", () => {
  const collectSnapshotIds = (doc: Doc): string[] => {
    const raw = doc.getMap().getText("t").toSnapshot() as { id: string }[];
    return raw.map((i) => i.id);
  };

  it("does not duplicate elements when a concurrent event arrives after gc", () => {
    const d = new Doc("zz");
    const t = d.getMap().getText("t");
    t.insert(0, "abc");
    t.delete(0, 1); // tombstone 'a'
    t.insert(2, "Z");
    d.gc(true); // compacts _data, must invalidate the undo cache

    // A concurrent event that sorts between zz:1 and zz:2 forces the ingest path
    // that would previously replay a stale undo closure.
    const concurrent: CrdtEvent = {
      id: "aa:2",
      replicaId: "aa",
      parents: ["zz:1"],
      op: { type: "map-set", path: [], key: "k", value: 1 },
    };
    d.egWalker.integrateRemote([concurrent]);

    const ids = collectSnapshotIds(d);
    // No duplicate RGA ids.
    expect(new Set(ids).size).toBe(ids.length);

    // The replica agrees with a fresh replay of its own event graph.
    const replay = new Doc("replay");
    replay.egWalker.integrateRemote(d.egWalker.graph.getAllEvents());
    expect(d.getMap().getText("t").toString()).toBe(
      replay.getMap().getText("t").toString(),
    );
  });

  it("stays convergent when a peer inserts near a gc'd region", () => {
    const a = new Doc("A");
    const b = new Doc("B");
    a.getMap().getText("t").insert(0, "hello");
    b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

    // A deletes "he", B concurrently inserts inside the surviving text.
    a.getMap().getText("t").delete(0, 2); // tombstone h,e
    b.getMap().getText("t").insert(3, "X"); // interior insert on B's copy

    // A garbage-collects its tombstones, then integrates B's concurrent insert.
    a.gc(true);
    const bEvents = b.egWalker.graph.getAllEvents();
    a.egWalker.integrateRemote(bEvents);
    // B integrates A's events too.
    b.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());

    const ta = a.getMap().getText("t").toString();
    const tb = b.getMap().getText("t").toString();

    // A stays self-consistent with a fresh replay of its (post-gc) graph.
    const replay = new Doc("replay");
    replay.egWalker.integrateRemote(a.egWalker.graph.getAllEvents());
    expect(ta).toBe(replay.getMap().getText("t").toString());
    // Both replicas converge.
    expect(ta).toBe(tb);
  });
});
