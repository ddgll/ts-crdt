import { YArray } from "./YArray.js";
import { YText } from "./YText.js";
import type { Doc } from "./Doc.js";
import { CrdtEvent, MAP_SET_OP } from "../eventGraph/eventGraph.js";

/**
 * A collaborative map that can be modified by multiple replicas.
 * It supports setting key-value pairs and can contain nested CRDTs.
 */
export class YMap {
	private _map: Map<string, unknown>;
	private _doc: Doc;
	private _path: (string | number)[];

	/**
	 * Creates a new YMap instance.
	 * @param doc The parent document.
	 * @param path The path of the map within the document.
	 * @internal
	 */
	constructor(doc: Doc, path: (string | number)[]) {
		this._map = new Map();
		this._doc = doc;
		this._path = path;
	}

	/**
	 * Sets a key-value pair in the map.
	 * This creates a local operation that will be propagated to other replicas.
	 * @param key The key to set.
	 * @param value The value to set.
	 * @returns The generated event.
	 */
	set(key: string, value: unknown): CrdtEvent {
		return this._doc.egWalker.localOp({
			type: MAP_SET_OP,
			path: this._path,
			key,
			value,
		});
	}

	/**
	 * Applies a set operation to the map's internal state.
	 * @param key The key to set.
	 * @param value The value to set.
	 * @internal
	 */
	_applySet(key: string, value: unknown) {
		this._map.set(key, value);
	}

	/**
	 * Internal method to set a value without generating an operation.
	 * Used by the EgWalker to build the document state from events.
	 * @internal
	 */
	_set(key: string, value: unknown) {
		this._map.set(key, value);
	}

	/**
	 * Gets the value associated with a key.
	 * @param key The key to retrieve.
	 * @returns The value associated with the key, or undefined if the key does not exist.
	 */
	get(key: string): unknown {
		return this._map.get(key);
	}

	/**
	 * Gets a nested YMap associated with a key.
	 * If the key does not exist or holds a different type, a new YMap is created and set.
	 * No event is generated for the container creation — operations on the created
	 * container will cause it to be created on remote replicas via path traversal.
	 * @param key The key of the nested map.
	 * @returns The nested YMap instance.
	 */
	getMap(key: string): YMap {
		const map = this._map.get(key);
		if (map === undefined) {
			const newMap = new YMap(this._doc, [...this._path, key]);
			this._set(key, newMap);
			return newMap;
		}
		if (!(map instanceof YMap)) {
			throw new Error("Type mismatch: expected YMap");
		}
		return map;
	}

	/**
	 * Gets a nested YArray associated with a key.
	 * If the key does not exist or holds a different type, a new YArray is created and set.
	 * No event is generated for the container creation — operations on the created
	 * container will cause it to be created on remote replicas via path traversal.
	 * @param key The key of the nested array.
	 * @returns The nested YArray instance.
	 */
	getArray(key: string): YArray {
		const array = this._map.get(key);
		if (array === undefined) {
			const newArray = new YArray(this._doc, [...this._path, key]);
			this._set(key, newArray);
			return newArray;
		}
		if (!(array instanceof YArray)) {
			throw new Error("Type mismatch: expected YArray");
		}
		return array;
	}

	/**
	 * Gets a nested YText associated with a key.
	 * If the key does not exist or holds a different type, a new YText is created and set.
	 * No event is generated for the container creation — operations on the created
	 * container will cause it to be created on remote replicas via path traversal.
	 * @param key The key of the nested text.
	 * @returns The nested YText instance.
	 */
	getText(key: string): YText {
		const text = this._map.get(key);
		if (text === undefined) {
			const newText = new YText(this._doc, [...this._path, key]);
			this._set(key, newText);
			return newText;
		}
		if (!(text instanceof YText)) {
			throw new Error("Type mismatch: expected YText");
		}
		return text;
	}

	/**
	 * Serializes the map and its nested CRDTs to a JSON-compatible format.
	 * @returns A JSON representation of the map.
	 */
	toJSON(): Record<string, unknown> {
		const obj: { [key: string]: unknown } = {};
		for (const [key, value] of this._map.entries()) {
			if (value instanceof YMap) {
				obj[key] = { crdtType: "YMap", data: value.toJSON() };
			} else if (value instanceof YArray) {
				obj[key] = { crdtType: "YArray", data: value.toJSON() };
			} else if (value instanceof YText) {
				obj[key] = { crdtType: "YText", data: value.toString() };
			} else {
				obj[key] = value;
			}
		}
		return obj;
	}

	/**
	 * Merges another YMap into this one.
	 * This is a shallow merge. For nested maps, it recursively merges.
	 * For other types, it overwrites the value.
	 * @param other The other YMap to merge.
	 */
	merge(other: YMap) {
		for (const [key, value] of other._map.entries()) {
			const existingValue = this._map.get(key);
			if (existingValue instanceof YMap && value instanceof YMap) {
				existingValue.merge(value);
			} else {
				this.set(key, value);
			}
		}
	}

	/**
	 * Creates a YMap instance from a JSON object.
	 * @param doc The parent document.
	 * @param path The path of the map within the document.
	 * @param json The JSON object to deserialize.
	 * @returns A new YMap instance with the deserialized data.
	 * @internal
	 */
	static fromJSON(
		doc: Doc,
		path: (string | number)[],
		json: Record<string, unknown>,
	): YMap {
		const map = new YMap(doc, path);
		for (const key in json) {
			const value = json[key] as
				| { crdtType: string; data: Record<string, unknown> }
				| Record<string, unknown>;
			if (value && typeof value === "object" && value.crdtType) {
				switch (value.crdtType) {
					case "YMap":
						map._applySet(
							key,
							YMap.fromJSON(
								doc,
								[...path, key],
								value.data as Record<string, unknown>,
							),
						);
						break;
					case "YArray":
						map._applySet(
							key,
							YArray.fromJSON(
								doc,
								[...path, key],
								value.data as unknown[],
							),
						);
						break;
					case "YText":
						map._applySet(
							key,
							YText.fromString(
								doc,
								[...path, key],
								value.data as string,
							),
						);
						break;
				}
			} else {
				map._applySet(key, value);
			}
		}
		return map;
	}
}
