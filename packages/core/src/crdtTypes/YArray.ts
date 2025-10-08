import type { Doc } from './Doc.js';
import { YMap } from './YMap.js';
import {
	ARRAY_DELETE_OP,
	ARRAY_INSERT_OP,
	ARRAY_REPLACE_OP,
} from '../eventGraph/eventGraph.js';

/**
 * A collaborative array that can be modified by multiple replicas.
 * It supports insertion, deletion, and replacement of elements.
 */
export class YArray {
	private _doc: Doc;
	private _path: (string | number)[];
	private _data: unknown[];

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
	 * Inserts new elements at a specified index.
	 * @param index The index at which to insert the elements.
	 * @param values The elements to insert.
	 */
	insert(index: number, values: unknown[]) {
		this._doc.egWalker.localOp({
			type: ARRAY_INSERT_OP,
			path: this._path,
			index,
			values,
		});
	}

	/**
	 * Deletes elements from a specified index.
	 * @param index The index at which to start deleting.
	 * @param length The number of elements to delete.
	 */
	delete(index: number, length: number) {
		this._doc.egWalker.localOp({
			type: ARRAY_DELETE_OP,
			path: this._path,
			index,
			length,
		});
	}

	/**
	 * Replaces the entire content of the array with new values.
	 * @param values The new elements for the array.
	 * @returns The generated event.
	 */
	replace(values: unknown[]) {
		return this._doc.egWalker.localOp({
			type: ARRAY_REPLACE_OP,
			path: this._path,
			values,
		});
	}

	/**
	 * Applies an insert operation to the array's internal state.
	 * @param index The index at which to insert.
	 * @param values The values to insert.
	 * @internal
	 */
	_applyInsert(index: number, values: unknown[]) {
		this._data.splice(index, 0, ...values);
	}

	/**
	 * Applies a delete operation to the array's internal state.
	 * @param index The index at which to start deleting.
	 * @param length The number of elements to delete.
	 * @internal
	 */
	_applyDelete(index: number, length: number) {
		this._data.splice(index, length);
	}

	/**
	 * Applies a replace operation to the array's internal state.
	 * @param values The new values for the array.
	 * @internal
	 */
	_applyReplace(values: unknown[]) {
		this._data = [...values];
	}

	/**
	 * Gets the element at a specified index.
	 * @param index The index of the element to retrieve.
	 * @returns The element at the specified index.
	 */
	get(index: number): unknown {
		return this._data[index];
	}

	/**
	 * Serializes the array and its nested CRDTs to a JSON-compatible format.
	 * @returns A JSON representation of the array.
	 */
	toJSON(): unknown[] {
		return this._data.map((item) => {
			if (item instanceof YMap) {
				return { crdtType: 'YMap', data: item.toJSON() };
			} else if (item instanceof YArray) {
				return { crdtType: 'YArray', data: item.toJSON() };
			}
			return item;
		});
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
		arr._data = json.map((itemData, i) => {
			const itemPath = [...path, i];
			if (
				itemData &&
				typeof itemData === 'object' &&
				'crdtType' in itemData &&
				'data' in itemData
			) {
				const { crdtType, data } = itemData as {
					crdtType: string;
					data: unknown;
				};
				switch (crdtType) {
					case 'YMap':
						return YMap.fromJSON(
							doc,
							itemPath,
							data as Record<string, unknown>,
						);
					case 'YArray':
						return YArray.fromJSON(doc, itemPath, data as unknown[]);
				}
			}
			return itemData;
		});
		return arr;
	}
}
