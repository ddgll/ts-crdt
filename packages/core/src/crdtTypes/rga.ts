import { compareEventIds } from "../eventGraph/eventGraph.js";

/**
 * The minimal shape a sequence element needs for insert-position resolution: a
 * stable, globally-unique id of the form `${eventId}:${offset}` (i.e.
 * `replicaId:lamport:offset`), plus the ids of the elements that were its left
 * and right neighbours at the moment it was inserted (its *origins*).
 *
 * The origins are what make interior insertion correct under concurrency: they
 * bound the region a concurrent insert may land in, so a run typed by one client
 * is never split by a run typed concurrently by another (the RGA/interleaving
 * anomaly). This is the YATA/Fugue model — see {@link rgaInsertIndex}.
 */
export interface SequenceItem {
	id: string;
	/** Id of the visible left neighbour at insert time, or null if inserted at the head. */
	originId: string | null;
	/** Id of the visible right neighbour at insert time, or null if inserted at the tail. */
	rightOriginId: string | null;
}

/**
 * @deprecated Retained as an alias of {@link SequenceItem} for backwards
 * compatibility; new code should use {@link SequenceItem}.
 */
export type RgaItem = SequenceItem;

/**
 * Extracts the base event id (`replicaId:lamport`) from a sequence item id.
 * Item ids are minted as `${eventId}:${offset}` by `_applyInsert`, so the base
 * id is the first two colon-separated segments.
 */
export function baseEventId(itemId: string): string {
	return itemId.split(":").slice(0, 2).join(":");
}

/**
 * Computes the array index at which a new run of sequence elements should be
 * inserted, using a YATA-style (Yjs/Fugue) integration that honours both a left
 * origin (`originId`) and a right origin (`rightOriginId`).
 *
 * Shared by {@link YArray} and {@link YText} so the convergence-critical
 * integration logic lives in exactly one place and cannot drift between them.
 *
 * **Why both origins.** With only a left anchor, an interior insert cannot be
 * bounded on the right, so it walks past unrelated following elements and lands
 * at the wrong place (it degenerates to append-at-end). Capturing the right
 * neighbour too pins the insert to the gap the author actually typed into, which
 * also prevents concurrently-typed runs from interleaving.
 *
 * **How ties are broken.** Elements are replayed in one deterministic total
 * order (ascending event id — Lamport first, then replicaId; see
 * {@link compareEventIds}), so at integration time every already-present element
 * has a smaller id than the inserting event. Among elements that share this
 * insert's left origin, the newest (this event) binds to their right, so
 * concurrent same-origin inserts settle in ascending event-id order. Elements
 * whose own origin lies to the left of this insert's origin keep the run
 * contiguous. Because every replica runs the identical scan over identical
 * state, they reach byte-identical results.
 *
 * @param data The current ordered array of items (including tombstones).
 * @param idIndex Map from item id to its index in `data`.
 * @param originId The left-origin item id to insert after, or null for the head.
 * @param rightOriginId The right-origin item id to insert before, or null for the tail.
 * @param eventId The base event id (`replicaId:lamport`) of the inserting event.
 * @returns The index in `data` at which the new run should be spliced.
 */
export function rgaInsertIndex(
	data: SequenceItem[],
	idIndex: Map<string, number>,
	originId: string | null,
	rightOriginId: string | null,
	eventId: string,
): number {
	// Resolve the left origin to an index. `left` is the index of the element we
	// currently intend to insert after; -1 means "insert at the very start".
	// A missing origin (only reachable if its anchor was garbage-collected without
	// a synchronising snapshot — a discouraged operation) falls back to the head so
	// the result stays deterministic across replicas that share the same state.
	let left = -1;
	if (originId !== null) {
		const oi = idIndex.get(originId);
		if (oi !== undefined) left = oi;
	}

	// Resolve the right origin to an exclusive upper bound for the scan.
	let rightBound = data.length;
	if (rightOriginId !== null) {
		const ri = idIndex.get(rightOriginId);
		if (ri !== undefined) rightBound = ri;
	}

	// YATA conflict-resolution scan over the open interval (left, rightBound).
	// `dest` tracks the element the new run will be spliced after.
	let dest = left;
	const scanned = new Set<string>();
	const conflicting = new Set<string>();
	for (let o = left + 1; o < rightBound; o++) {
		const item = data[o];
		scanned.add(item.id);
		conflicting.add(item.id);

		if (item.originId === originId) {
			// Same left origin => a concurrent sibling. Replay order guarantees this
			// event is the newest, so bind to the sibling's right (ascending id).
			if (compareEventIds(baseEventId(item.id), eventId) < 0) {
				dest = o;
				conflicting.clear();
			} else if (item.rightOriginId === rightOriginId) {
				// Same origin *and* right origin, and the sibling is newer than us
				// (only possible outside strict newest-last replay): stop here.
				break;
			}
		} else if (item.originId !== null && scanned.has(item.originId)) {
			// The element's own origin lies within the already-scanned window, i.e.
			// to the left of our origin's subtree. Keep it left of us unless it is
			// itself one of our unresolved conflicting siblings.
			if (!conflicting.has(item.originId)) {
				dest = o;
				conflicting.clear();
			}
		} else {
			// The element belongs to a region left of our origin: stop scanning.
			break;
		}
	}

	return dest + 1;
}
