import type { Doc } from "./doc.js";
import { YMap } from "./yMap.js";
import { YText } from "./yText.js";
import {
	ARRAY_DELETE_OP,
	ARRAY_INSERT_OP,
} from "../eventGraph/eventGraph.js";
import { rgaInsertIndex } from "./rga.js";

/**
 * Internal representation of an item in the YArray.
 */
interface YArrayItem {
	id: string;
	value: unknown;
	isDeleted: boolean;
}

/**
 * A collaborative array that can be modified by multiple replicas.
 * It supports insertion, deletion, and replacement of elements.
 * 
 * **Note on Concurrency**: YArray resolves concurrent index-based operations
 * via deterministic event replay using RGA-like stable IDs, preserving user intent.
 */
export class YArray {
	private _doc: Doc;
	private _path: (string | number)[];
	private _data: YArrayItem[];
	private _idIndex: Map<string, number>;
	private _activeCount: number;

	/**
	 * Creates a new YArray instance.
	 * @param doc The parent document.
	 * @param path The path of the array within the document.
	 * @internal
	 */
	constructor(doc: Doc, path: (string | number)[]) {
		this._doc = doc;
		this._path = path;
		this._data = [];
		this._idIndex = new Map();
		this._activeCount = 0;
	}

	/**
	 * Gets the number of non-deleted elements in the array.
	 */
	get length(): number {
		return this._activeCount;
	}

	/**
	 * Inserts new elements at a specified index.
	 * @param index The index at which to insert the elements.
	 * @param values The elements to insert.
	 */
	insert(index: number, values: unknown[]) {
		let afterId: string | null = null;
		if (index > 0) {
			let count = 0;
			for (let i = 0; i < this._data.length; i++) {
				if (!this._data[i].isDeleted) {
					count++;
					if (count === index) {
						afterId = this._data[i].id;
						break;
					}
				}
			}
		}
		
		this._doc.egWalker.localOp({
			type: ARRAY_INSERT_OP,
			path: this._path,
			afterId,
			values,
		});
	}

	/**
	 * Deletes elements from a specified index.
	 * @param index The index at which to start deleting.
	 * @param length The number of elements to delete.
	 */
	delete(index: number, length: number) {
		const targetIds: string[] = [];
		let count = 0;
		for (let i = 0; i < this._data.length; i++) {
			if (!this._data[i].isDeleted) {
				if (count >= index && count < index + length) {
					targetIds.push(this._data[i].id);
				}
				count++;
				if (count === index + length) break;
			}
		}

		if (targetIds.length > 0) {
			this._doc.egWalker.localOp({
				type: ARRAY_DELETE_OP,
				path: this._path,
				targetIds,
			});
		}
	}

	/**
	 * Replaces the entire content of the array with new values.
	 * This is a macro that issues discrete ARRAY_DELETE_OP and ARRAY_INSERT_OP commands.
	 * @param values The new elements for the array.
	 */
	replace(values: unknown[]) {
		this.delete(0, this.length);
		this.insert(0, values);
	}

	/**
	 * Applies an insert operation to the array's internal state.
	 * @param eventId The ID of the event triggering the insert.
	 * @param afterId The ID of the element to insert after.
	 * @param values The values to insert.
	 * @returns An undo closure.
	 * @internal
	 */
	_applyInsert(eventId: string, afterId: string | null, values: unknown[]): () => void {
		// RGA tie-breaking is shared with YText via rgaInsertIndex so the
		// convergence-critical convention lives in exactly one place.
		const insertIdx = rgaInsertIndex(this._data, this._idIndex, afterId, eventId);

		const newItems: YArrayItem[] = values.map((val, i) => ({
			id: `${eventId}:${i}`,
			value: val,
			isDeleted: false
		}));

		this._data.splice(insertIdx, 0, ...newItems);

		// Rebuild index from insertIdx onward (shifted elements)
		for (let i = insertIdx; i < this._data.length; i++) {
			this._idIndex.set(this._data[i].id, i);
		}
		this._activeCount += values.length;

		// Undo splices out the exact [insertIdx, count] span rather than
		// filtering by an id membership test (O(n*m) + full index rebuild). This
		// is safe because undo closures are always invoked in strict LIFO order
		// (see EgWalker._ingestEvents), so at undo time the inserted run is still
		// contiguous at insertIdx. Only the shifted suffix is re-indexed.
		const insertedIds = newItems.map(item => item.id);
		const count = newItems.length;
		return () => {
			this._data.splice(insertIdx, count);
			for (const id of insertedIds) {
				this._idIndex.delete(id);
			}
			for (let i = insertIdx; i < this._data.length; i++) {
				this._idIndex.set(this._data[i].id, i);
			}
			this._activeCount -= values.length;
		};
	}

	/**
	 * Applies a delete operation to the array's internal state.
	 * @param targetIds The IDs of the elements to delete.
	 * @returns An undo closure.
	 * @internal
	 */
	_applyDelete(targetIds: string[]): () => void {
		const toggledIds: string[] = [];
		for (const id of targetIds) {
			const idx = this._idIndex.get(id);
			if (idx !== undefined) {
				if (!this._data[idx].isDeleted) {
					this._data[idx].isDeleted = true;
					this._activeCount--;
					toggledIds.push(id);
				}
			}
		}

		return () => {
			for (const id of toggledIds) {
				const idx = this._idIndex.get(id);
				if (idx !== undefined) {
					this._data[idx].isDeleted = false;
					this._activeCount++;
				}
			}
		};
	}



	/**
	 * Captures the parameters needed to re-insert the given items, for undoing a
	 * delete. Reads the current internal order so the revived content is placed
	 * back after the same predecessor. Must be called while the target items are
	 * still present (i.e. before the delete is applied, or against a tombstone that
	 * has not been garbage-collected).
	 * @param targetIds The ids of the items whose content should be revived.
	 * @returns The anchor id and values for an {@link ARRAY_INSERT_OP}, or null if
	 *   none of the targets are present.
	 * @internal
	 */
	_captureReinsert(targetIds: string[]): { afterId: string | null; values: unknown[] } | null {
		const idSet = new Set(targetIds);
		const values: unknown[] = [];
		let firstIdx = -1;
		for (let i = 0; i < this._data.length; i++) {
			if (idSet.has(this._data[i].id)) {
				if (firstIdx === -1) firstIdx = i;
				values.push(this._data[i].value);
			}
		}
		if (firstIdx === -1) return null;
		const afterId = firstIdx > 0 ? this._data[firstIdx - 1].id : null;
		return { afterId, values };
	}

	/**
	 * Performs garbage collection by cleanly splicing out elements marked as deleted.
	 *
	 * WARNING: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization.
	 * It should only be called when all clients are guaranteed to receive a synchronized snapshot to prevent permanent replica divergence.
	 *
	 * Tombstones double as RGA insertion anchors (`rgaInsertIndex` resolves an
	 * insert's position by locating its `afterId` in `_data`). A tombstone is
	 * therefore only safe to remove when it is causally stable AND no
	 * not-yet-folded event still references it as an anchor; otherwise that event
	 * would fall back to append-at-end and silently reorder content. See PLAN_10.
	 *
	 * @param force Must be explicitly set to true to execute garbage collection.
	 */
	gc(force: boolean = false) {
		if (!force) {
			throw new Error("Garbage collection must be explicitly forced by passing true (e.g. gc(true)). Warning: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization if clients are not fully synchronized via snapshots.");
		}
		this._data = this._data.filter(item => !item.isDeleted);
		this._idIndex.clear();
		for (let i = 0; i < this._data.length; i++) {
			this._idIndex.set(this._data[i].id, i);
			const value = this._data[i].value;
			if (value instanceof YMap || value instanceof YArray || value instanceof YText) {
				value.gc(force);
			}
		}
		this._activeCount = this._data.length;
	}

	/**
	 * Gets the element at a specified index.
	 * @param index The index of the element to retrieve.
	 * @returns The element at the specified index.
	 */
	get(index: number): unknown {
		let count = 0;
		for (const item of this._data) {
			if (!item.isDeleted) {
				if (count === index) return item.value;
				count++;
			}
		}
		return undefined;
	}

	/**
	 * Serializes the array and its nested CRDTs to a JSON-compatible format.
	 * @returns A JSON representation of the array.
	 */
	toJSON(): unknown[] {
		const result: unknown[] = [];
		for (const item of this._data) {
			if (!item.isDeleted) {
				let val = item.value;
				if (val instanceof YMap) {
					val = { __crdt_type: "YMap", data: val.toJSON() };
				} else if (val instanceof YArray) {
					val = { __crdt_type: "YArray", data: val.toJSON() };
				} else if (val instanceof YText) {
					val = { __crdt_type: "YText", data: val.toString() };
				}
				result.push(val);
			}
		}
		return result;
	}

	/**
	 * Serializes the array and its nested CRDTs to a snapshot format that preserves CRDT metadata.
	 * @returns A raw representation of the array.
	 */
	toSnapshot(): unknown[] {
		const result: unknown[] = [];
		for (const item of this._data) {
			let val = item.value;
			if (val instanceof YMap) {
				val = { __crdt_type: "YMap", data: val.toSnapshot() };
			} else if (val instanceof YArray) {
				val = { __crdt_type: "YArray", data: val.toSnapshot() };
			} else if (val instanceof YText) {
				val = { __crdt_type: "YText", data: val.toSnapshot() };
			}
			result.push({
				id: item.id,
				value: val,
				isDeleted: item.isDeleted
			});
		}
		return result;
	}

	/**
	 * Creates a YArray instance from a JSON object.
	 *
	 * **LOSSY / NON-COLLABORATIVE:** items receive synthetic, path-derived ids
	 * (`snapshot:<path>:<index>`) and tombstones are dropped. These ids are not
	 * globally unique across replicas, so a JSON-loaded array cannot be safely
	 * used in a collaborative sync flow — use {@link YArray.fromSnapshot} (which
	 * preserves real RGA ids and tombstones) for that. See {@link Doc.fromJSON}.
	 * @param doc The parent document.
	 * @param path The path of the array within the document.
	 * @param json The JSON object to deserialize.
	 * @returns A new YArray instance with the deserialized data.
	 * @internal
	 */
	static fromJSON(
		doc: Doc,
		path: (string | number)[],
		json: unknown[],
	): YArray {
		const arr = new YArray(doc, path);
		// Note: when loading from a JSON snapshot, we don't have the original event IDs.
		// A proper snapshot needs to serialize the RGA IDs as well. But for this simplified demo,
		// we assign temporary stable IDs based on the path if this is a brand new array load.
		arr._data = json.map((itemData, i) => {
			const itemPath = [...path, i];
			let parsedValue = itemData;
			if (
				isRecord(itemData) &&
				"__crdt_type" in itemData &&
				"data" in itemData
			) {
				const __crdt_type = itemData.__crdt_type;
				const data = itemData.data;
				switch (__crdt_type) {
					case "YMap":
						if (isRecord(data)) {
							parsedValue = YMap.fromJSON(
								doc,
								itemPath,
								data,
							);
						}
						break;
					case "YArray":
						if (isUnknownArray(data)) {
							parsedValue = YArray.fromJSON(
								doc,
								itemPath,
								data,
							);
						}
						break;
					case "YText":
						if (isString(data)) {
							parsedValue = YText.fromString(
								doc,
								itemPath,
								data,
							);
						}
						break;
				}
			}
			return {
				id: `snapshot:${path.join('.')}:${i}`,
				value: parsedValue,
				isDeleted: false
			};
		});
		for (let i = 0; i < arr._data.length; i++) {
			arr._idIndex.set(arr._data[i].id, i);
		}
		arr._activeCount = arr._data.length;
		return arr;
	}

	/**
	 * Creates a YArray instance from a snapshot object.
	 * @param doc The parent document.
	 * @param path The path of the array within the document.
	 * @param snapshot The snapshot object to deserialize.
	 * @returns A new YArray instance with the deserialized data.
	 * @internal
	 */
	static fromSnapshot(
		doc: Doc,
		path: (string | number)[],
		snapshot: unknown[],
	): YArray {
		const arr = new YArray(doc, path);
		arr._data = snapshot.map((itemData, i) => {
			if (!isSnapshotItem(itemData)) return { id: "", value: null, isDeleted: true };
			const itemPath = [...path, i];
			let parsedValue = itemData.value;
			if (
				isRecord(itemData.value) &&
				"__crdt_type" in itemData.value &&
				"data" in itemData.value
			) {
				const __crdt_type = itemData.value.__crdt_type;
				const data = itemData.value.data;
				switch (__crdt_type) {
					case "YMap":
						if (isRecord(data)) {
							parsedValue = YMap.fromSnapshot(
								doc,
								itemPath,
								data,
							);
						}
						break;
					case "YArray":
						if (isUnknownArray(data)) {
							parsedValue = YArray.fromSnapshot(
								doc,
								itemPath,
								data,
							);
						}
						break;
					case "YText":
						if (isUnknownArray(data)) {
							parsedValue = YText.fromSnapshot(
								doc,
								itemPath,
								data,
							);
						}
						break;
				}
			}
			return {
				id: itemData.id,
				value: parsedValue,
				isDeleted: itemData.isDeleted
			};
		});
		let activeCount = 0;
		for (let i = 0; i < arr._data.length; i++) {
			arr._idIndex.set(arr._data[i].id, i);
			if (!arr._data[i].isDeleted) {
				activeCount++;
			}
		}
		arr._activeCount = activeCount;
		return arr;
	}
}

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isUnknownArray(val: unknown): val is unknown[] {
	return Array.isArray(val);
}

function isString(val: unknown): val is string {
	return typeof val === "string";
}

function isSnapshotItem(val: unknown): val is { id: string; value: unknown; isDeleted: boolean } {
	return isRecord(val) && typeof val.id === "string" && typeof val.isDeleted === "boolean";
}
