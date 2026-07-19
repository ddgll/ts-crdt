import { YMap } from './yMap.js';
import { EgWalker } from '../egWalker/egWalker.js';
import {
	MAP_SET_OP,
} from '../eventGraph/eventGraph.js';
import { Logger, getLogger } from '../logger.js';

/**
 * A CRDT document that holds the state of the collaborative data.
 * It serves as the entry point for creating and managing shared data types.
 */
export class Doc {
	private _root: YMap;
	/**
	 * The EgWalker instance that manages the event graph and replication for this document.
	 */
	public egWalker: EgWalker;
	/** Logger propagated to the EgWalker; retained so {@link clear} preserves it. */
	private _logger: Logger;

	/**
	 * Creates a new Doc instance.
	 * @param replicaId An optional unique identifier for this replica. If not provided, a strong random id will be generated.
	 * @param logger An optional logger for diagnostics. Defaults to the process-wide logger (see {@link setLogger}).
	 */
	constructor(replicaId?: string, logger: Logger = getLogger()) {
		this._logger = logger;
		this.egWalker = new EgWalker(this, replicaId, undefined, logger);
		this._root = new YMap(this, []);
	}

	/**
	 * Gets the root YMap of the document.
	 * All shared data should be nested under this root map.
	 * @returns The root YMap instance.
	 */
	getMap(): YMap {
		return this._root;
	}

	/**
	 * Clears the document's state, effectively resetting it to an empty state.
	 * A new EgWalker is created, and the root YMap is replaced.
	 */
	clear() {
		// Generate a new EgWalker with a fresh replicaId to prevent event ID
		// collisions with events from the old session that may exist on other replicas.
		this.egWalker = new EgWalker(this, undefined, undefined, this._logger);
		this._root = new YMap(this, []);
	}

	/**
	 * Performs garbage collection on the document to clean up tombstones and free memory.
	 *
	 * WARNING: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization.
	 * It should only be called when all clients are guaranteed to receive a synchronized snapshot to prevent permanent replica divergence.
	 *
	 * A tombstone is only safe to gc when it is both (a) causally stable — every
	 * replica has observed it — AND (b) not referenced as an insertion anchor
	 * (`afterId`) by any event that has not yet been folded into the same
	 * snapshot. Tombstones are RGA anchors, so dropping one that a future insert
	 * still points at would strand that insert (it would append at the end
	 * instead of at its intended position). Compaction satisfies (b) because an
	 * insert can only anchor to an item its author had visible, so any event
	 * anchored to a tombstone is necessarily causally before that tombstone's
	 * deletion and is folded into the snapshot alongside it (see PLAN_10 and
	 * `server/tests/compactionGcAnchorLoss.test.ts`).
	 *
	 * @param force Must be explicitly set to true to execute garbage collection.
	 */
	gc(force: boolean = false) {
		if (!force) {
			throw new Error("Garbage collection must be explicitly forced by passing true (e.g. gc(true)). Warning: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization if clients are not fully synchronized via snapshots.");
		}
		this._root.gc(force);
		// gc() splices tombstones out of each type's internal `_data`, which
		// invalidates the by-value indices captured in the walker's incremental
		// undo closures. Drop them so the next ingest rebuilds from the event graph
		// (which still holds the folded history) instead of replaying a stale
		// closure onto compacted data — see EgWalker.invalidateUndoCache.
		this.egWalker.invalidateUndoCache();
	}

	/**
	 * Applies a generic update to the document.
	 * This method is a low-level way to apply operations and is typically used for specific update formats.
	 * @param update The update object to apply.
	 * @internal
	 */
	applyUpdate(update: {
		path: (string | number)[];
		payload: { type: string; key: string; value: unknown };
	}) {
		if (update.payload.type === 'set') {
			this.egWalker.localOp({
				type: MAP_SET_OP,
				path: update.path,
				key: update.payload.key,
				value: update.payload.value,
			});
		} else {
			throw new Error(`Unsupported update type: ${update.payload.type}`);
		}
	}

	/**
	 * Serializes the entire document to a JSON object.
	 * @returns A JSON representation of the document's data.
	 */
	toJSON() {
		return this._root.toJSON();
	}

	/**
	 * Serializes the entire document to a snapshot object preserving metadata.
	 * @returns A raw representation of the document's data.
	 */
	getSnapshot() {
		return this._root.toSnapshot();
	}

	/**
	 * Creates a new Doc instance from a plain JSON object.
	 *
	 * **LOSSY / NON-COLLABORATIVE.** This is a convenience loader for local,
	 * single-replica use (display, tests, seeding). It does **not** preserve CRDT
	 * identity:
	 * - Array/text elements are assigned *synthetic, path-derived* ids
	 *   (`snapshot:<path>:<index>`). These are not globally unique across
	 *   replicas, so a document loaded this way on two replicas will mint
	 *   colliding ids and **fail to converge** if then edited collaboratively.
	 * - Tombstones (deleted-but-retained elements) are dropped, so concurrent
	 *   edits that reference deleted positions cannot be integrated correctly.
	 *
	 * For any collaborative/sync flow, load from a snapshot instead
	 * ({@link EgWalker.loadStateSnapshot} / `YMap.fromSnapshot`), which preserves
	 * the real RGA ids and tombstones.
	 * @param json The JSON object to deserialize.
	 * @returns A new Doc instance with the deserialized data.
	 */
	static fromJSON(json: Record<string, unknown>): Doc {
		const doc = new Doc();
		doc._root = YMap.fromJSON(doc, [], json);
		return doc;
	}

	/**
	 * Sets the root YMap of the document.
	 * @param root The new root YMap.
	 * @internal
	 */
	_setRoot(root: YMap) {
		this._root = root;
	}

}
