import type { Doc } from "./doc.js";
import { YMap } from "./yMap.js";
import {
	ARRAY_DELETE_OP,
	ARRAY_INSERT_OP,
	ARRAY_REPLACE_OP,
} from "../eventGraph/eventGraph.js";

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
	}

	/**
	 * Gets the number of non-deleted elements in the array.
	 */
	get length(): number {
		return this._data.filter(i => !i.isDeleted).length;
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
	 * This is an atomic operation that generates a single ARRAY_REPLACE_OP event.
	 * @param values The new elements for the array.
	 */
	replace(values: unknown[]) {
		this._doc.egWalker.localOp({
			type: ARRAY_REPLACE_OP,
			path: this._path,
			values,
		});
	}

	/**
	 * Applies an insert operation to the array's internal state.
	 * @param eventId The ID of the event triggering the insert.
	 * @param afterId The ID of the element to insert after.
	 * @param values The values to insert.
	 * @internal
	 */
	_applyInsert(eventId: string, afterId: string | null, values: unknown[]) {
		let insertIdx = 0;
		if (afterId !== null) {
			const idx = this._data.findIndex(item => item.id === afterId);
			if (idx !== -1) {
				insertIdx = idx + 1;
			} else {
				// Fallback if afterId not found (shouldn't happen with valid topological sort)
				insertIdx = this._data.length;
			}
		}

		const newItems: YArrayItem[] = values.map((val, i) => ({
			id: `${eventId}:${i}`,
			value: val,
			isDeleted: false
		}));

		this._data.splice(insertIdx, 0, ...newItems);
	}

	/**
	 * Applies a delete operation to the array's internal state.
	 * @param targetIds The IDs of the elements to delete.
	 * @internal
	 */
	_applyDelete(targetIds: string[]) {
		const targetSet = new Set(targetIds);
		for (const item of this._data) {
			if (targetSet.has(item.id)) {
				item.isDeleted = true;
			}
		}
	}

	/**
	 * Applies a replace operation to the array's internal state.
	 * @param eventId The ID of the replace event.
	 * @param values The new values for the array.
	 * @internal
	 */
	_applyReplace(eventId: string, values: unknown[]) {
		// Mark everything as deleted
		for (const item of this._data) {
			item.isDeleted = true;
		}
		// Insert new values at the end (or anywhere, since everything else is deleted)
		const newItems: YArrayItem[] = values.map((val, i) => ({
			id: `${eventId}:${i}`,
			value: val,
			isDeleted: false
		}));
		this._data.push(...newItems);
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
					val = { crdtType: "YMap", data: val.toJSON() };
				} else if (val instanceof YArray) {
					val = { crdtType: "YArray", data: val.toJSON() };
				}
				result.push(val);
			}
		}
		return result;
	}

	/**
	 * Creates a YArray instance from a JSON object.
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
				itemData &&
				typeof itemData === "object" &&
				"crdtType" in itemData &&
				"data" in itemData
			) {
				const { crdtType, data } = itemData as {
					crdtType: string;
					data: unknown;
				};
				switch (crdtType) {
					case "YMap":
						parsedValue = YMap.fromJSON(
							doc,
							itemPath,
							data as Record<string, unknown>,
						);
						break;
					case "YArray":
						parsedValue = YArray.fromJSON(
							doc,
							itemPath,
							data as unknown[],
						);
						break;
				}
			}
			return {
				id: `snapshot:${path.join('.')}:${i}`,
				value: parsedValue,
				isDeleted: false
			};
		});
		return arr;
	}
}
