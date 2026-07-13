# PLAN_10 — GC during compaction can drop tombstones still needed as RGA anchors

**Type:** Correctness risk · **Severity:** Medium · **Mandatory:** Investigate first; fix only if reproduced.

**Status: DOWNGRADED — documented non-issue.** Investigated and could not be
reproduced through the public API; see "Resolution" below.

## Problem

Compaction builds the snapshot by rebuilding state at the critical version and then calling
`gc(true)`, which **permanently removes tombstones**:

```ts
// crdtServer.ts:495-502
const tempDoc = new Doc(undefined, this.logger);
const eventsToApply = ...getEvents(version)...;
tempDoc.egWalker.integrateRemote(eventsToApply);
tempDoc.gc(true);                 // <-- deletes deleted-but-retained items
const snap = tempDoc.getSnapshot();
```

Tombstones in an RGA are not dead weight — they are **insertion anchors**. `rgaInsertIndex` resolves
an insert's position by finding `afterId` in the current data (rga.ts:58-64). If a *remaining* event
(one kept after compaction because it is concurrent with / after the critical version) has an
`afterId` that points at a character which was already deleted at the critical version and then
gc'd out of the snapshot, the anchor is gone. `rgaInsertIndex` then falls back to **append at end**
(rga.ts:59-64).

## How bad is it, really?

Because the server broadcasts the post-compaction snapshot to every client and everyone replays the
same remaining events in the same total order, **all replicas still converge** (they all do the same
"append at end"). So this is *not* a divergence bug. It is a **silent content-reordering bug**:
text/array elements can jump to the end of the document after a compaction, corrupting the intended
order that users saw before compaction.

Whether it triggers depends on whether a kept event can legitimately anchor to a pre-critical-version
tombstone. That requires: item X inserted and deleted before the critical version, and a concurrent
event anchored `after X` that is not itself an ancestor of the critical version. This is plausible
under concurrent edit + delete near a compaction boundary.

## Evidence

- `packages/core/src/server/crdtServer.ts:495-502` (gc before snapshot)
- `packages/core/src/crdtTypes/rga.ts:58-64` (anchor-not-found → append fallback)
- `packages/core/src/crdtTypes/yArray.ts:231-245`, `yText.ts:363-372` (gc removes tombstones)
- Existing test `packages/core/src/server/tests/compactionConcurrentDelete.test.ts` (PLAN_07.4) —
  check whether it exercises *an insert anchored to a gc'd tombstone*, or only delete-of-visible.

## Actions

1. **Write a targeted test** that reproduces the scenario: base doc, concurrent insert-after-X while
   X is concurrently deleted, then compact, then assert the inserted run keeps its position. If it
   passes, downgrade this plan to "documented non-issue."
2. **If it reproduces, stop gc'ing anchors that remaining events reference.** Options:
   - Do **not** gc during compaction; keep tombstones in the snapshot (`toSnapshot` already
     preserves `isDeleted`). Trade memory for correctness. Simplest and safest.
   - Or gc only tombstones that are **not** referenced as `afterId` by any remaining event's
     insert op — a targeted sweep instead of a blanket gc.
3. **Regardless, tighten the docstring** on `gc()` and on `compact()` to state that gc is only safe
   for tombstones that are causally stable *and unreferenced by future inserts*.

## Argument

The current `gc(true)` docstring already warns it "can cause CRDT desynchronization." Compaction
calls it unconditionally on the assumption the critical version makes everything before it stable —
but "stable" (all replicas past it) is not the same as "no future event anchors into it." The
conservative fix (keep tombstones in the snapshot) costs only memory and removes the risk entirely.

## Resolution (investigated 2026-07-13)

**Could not reproduce. Downgraded to a documented non-issue; no behavioural change made.**

The feared condition — a *remaining* event whose `afterId` points at a tombstone that gc removed
from the snapshot — is **structurally impossible via the public API**:

1. The index-based `YArray.insert` / `YText.insert` resolve `afterId` by scanning for the Nth
   **visible** (non-deleted) item (`yArray.ts:59-72`). An op therefore only ever anchors to an item
   its author had visible at authoring time.
2. So an insert with `afterId = X` implies the author had **not** seen X's deletion — i.e. the
   insert is concurrent with (or precedes) delete-X.
3. For X to be a tombstone folded into the snapshot, delete-X must be an ancestor of the critical
   version `c`.
4. A *remaining* event is by definition a **strict descendant of `c`** (`getChangesSince` returns
   exactly the non-ancestors of `c`). A strict descendant of `c` is a descendant of delete-X, so it
   *did* see the delete — contradicting (2).

Hence no remaining event can anchor to a gc'd tombstone. Any event anchored to X is causally before
delete-X, so it is itself folded into the snapshot with its position already resolved; gc then
splices X out without disturbing that already-placed content.

Empirical confirmation: `packages/core/src/server/tests/compactionGcAnchorLoss.test.ts` builds the
exact scenario (base `[A, X, B]`; branch deletes X; concurrent branch inserts `P` after X; a merge
event makes delete-X an ancestor of the critical version so X *is* gc'd; two further concurrent
edits leave genuine remaining events). It asserts (a) gc really removed X's anchor id from the
snapshot, (b) the compacted server converges to the byte-identical non-compacted reference, and
(c) no remaining event's `afterId` is missing from the post-gc snapshot. All pass.

Note discovered while investigating: an insert anchored `after X` where X sits mid-run can land at
the end of the run even **without** any compaction, because `rgaInsertIndex` skips siblings with a
smaller base event id (the RGA tie-break). That is existing, compaction-independent RGA behaviour —
compaction faithfully reproduces it — and is out of scope for PLAN_10.

Docstrings on `Doc.gc`, `YArray.gc`, `YText.gc`, and `CrdtServer.compact` were tightened per action 3
to state gc is only safe for tombstones that are causally stable **and** unreferenced by
not-yet-folded inserts, and to explain why compaction satisfies that condition.
