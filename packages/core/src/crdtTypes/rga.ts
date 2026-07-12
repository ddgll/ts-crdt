import { compareEventIds } from "../eventGraph/eventGraph.js";

/**
 * The minimal shape an RGA element needs for insert-position resolution: a
 * stable, globally-unique id of the form `${eventId}:${offset}` (i.e.
 * `replicaId:lamport:offset`).
 */
export interface RgaItem {
	id: string;
}

/**
 * Extracts the base event id (`replicaId:lamport`) from an RGA item id.
 * Item ids are minted as `${eventId}:${offset}` by `_applyInsert`, so the base
 * id is the first two colon-separated segments.
 */
export function baseEventId(itemId: string): string {
	return itemId.split(":").slice(0, 2).join(":");
}

/**
 * Computes the array index at which a new RGA element should be inserted.
 *
 * Shared by {@link YArray} and {@link YText} so the tie-break logic lives in one
 * place and cannot drift between the two types.
 *
 * **Tie-break convention.** Among elements that follow the same anchor
 * (`afterId`), the new run is placed *after* every existing element whose base
 * event id is strictly smaller than `eventId`, and *before* the first element
 * whose base event id is greater than or equal to `eventId`. Because
 * `compareEventIds` orders by Lamport timestamp first (see PLAN_01) then by
 * `replicaId`, concurrent inserts sharing an anchor settle into ascending
 * event-id order — deterministically and identically on every replica.
 *
 * **Why this converges.** Convergence does not rely on this being a textbook
 * RGA integration. The egWalker replays every event in a single deterministic
 * topological order (keyed on event id), so all replicas run this function over
 * identical state in an identical sequence and therefore reach byte-identical
 * results. The convention above only pins *which* interleaving the replicas
 * agree on; see the pinned unit tests in `rgaTiebreak.test.ts`.
 *
 * @param data The current ordered array of items (including tombstones).
 * @param idIndex Map from item id to its index in `data`.
 * @param afterId The anchor item id to insert after, or `null` to insert at the head.
 * @param eventId The base event id (`replicaId:lamport`) of the inserting event.
 * @returns The index in `data` at which the new run should be spliced.
 */
export function rgaInsertIndex(
	data: RgaItem[],
	idIndex: Map<string, number>,
	afterId: string | null,
	eventId: string,
): number {
	if (afterId === null) {
		return 0;
	}

	const idx = idIndex.get(afterId);
	if (idx === undefined) {
		// Anchor not found. With a valid topological sort the anchor is always
		// already present, so this only happens for malformed input; append
		// rather than silently drop the insert.
		return data.length;
	}

	let insertIdx = idx + 1;
	while (insertIdx < data.length) {
		const siblingBaseId = baseEventId(data[insertIdx].id);
		if (compareEventIds(siblingBaseId, eventId) < 0) {
			insertIdx++;
		} else {
			break;
		}
	}
	return insertIdx;
}
