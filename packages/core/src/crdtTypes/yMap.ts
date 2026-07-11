import { YArray } from "./yArray.js";
import { YText } from "./yText.js";
import type { Doc } from "./doc.js";
import { CrdtEvent, MAP_SET_OP, MAP_DELETE_OP, compareEventIds } from "../eventGraph/eventGraph.js";

/**
 * A collaborative map that can be modified by multiple replicas.
 * It supports setting key-value pairs and can contain nested CRDTs.
 */
export class YMap {
	private _map: Map<string, { value: unknown; eventId?: string }>;
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
	 * Deletes a key from the map.
	 * This creates a local operation that will be propagated to other replicas.
	 * @param key The key to delete.
	 * @returns The generated event.
	 */
	delete(key: string): CrdtEvent {
		return this._doc.egWalker.localOp({
			type: MAP_DELETE_OP,
			path: this._path,
			key,
		});
	}

	/**
	 * Applies a set operation to the map's internal state.
	 * @param key The key to set.
	 * @param value The value to set.
	 * @param eventId The event ID (used for last-writer-wins conflict resolution).
	 * @returns An undo closure.
	 * @internal
	 */
	_applySet(key: string, value: unknown, eventId?: string): () => void {
		const existing = this._map.get(key);
		const capturedValue = existing?.value;
		const capturedEventId = existing?.eventId;
		const didExist = existing !== undefined;

		let applied = false;
		if (!existing || !eventId || !existing.eventId || compareEventIds(eventId, existing.eventId) >= 0) {
			this._map.set(key, { value, eventId });
			applied = true;
		}

		return () => {
			if (applied) {
				if (didExist) {
					this._map.set(key, { value: capturedValue, eventId: capturedEventId });
				} else {
					this._map.delete(key);
				}
			}
		};
	}

	/**
	 * Applies a delete operation to the map's internal state.
	 * @param key The key to delete.
	 * @returns An undo closure.
	 * @internal
	 */
	_applyDelete(key: string): () => void {
		const existing = this._map.get(key);
		const capturedValue = existing?.value;
		const capturedEventId = existing?.eventId;
		const didExist = existing !== undefined;

		this._map.delete(key);

		return () => {
			if (didExist) {
				this._map.set(key, { value: capturedValue, eventId: capturedEventId });
			}
		};
	}



	/**
	 * Gets the value associated with a key.
	 * @param key The key to retrieve.
	 * @returns The value associated with the key, or undefined if the key does not exist.
	 */
	get(key: string): unknown {
		return this._map.get(key)?.value;
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
		const wrapper = this._map.get(key);
		const map = wrapper?.value;
		if (map === undefined) {
			const newMap = new YMap(this._doc, [...this._path, key]);
			this._applySet(key, newMap);
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
		const wrapper = this._map.get(key);
		const array = wrapper?.value;
		if (array === undefined) {
			const newArray = new YArray(this._doc, [...this._path, key]);
			this._applySet(key, newArray);
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
		const wrapper = this._map.get(key);
		const text = wrapper?.value;
		if (text === undefined) {
			const newText = new YText(this._doc, [...this._path, key]);
			this._applySet(key, newText);
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
		for (const [key, wrapper] of this._map.entries()) {
			const value = wrapper.value;
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
		for (const [key, wrapper] of other._map.entries()) {
			const value = wrapper.value;
			const existingWrapper = this._map.get(key);
			const existingValue = existingWrapper?.value;
			if (existingValue instanceof YMap && value instanceof YMap) {
				existingValue.merge(value);
			} else if (value instanceof YMap) {
				this.set(key, YMap.fromJSON(this._doc, [...this._path, key], value.toJSON()));
			} else if (value instanceof YArray) {
				this.set(key, YArray.fromJSON(this._doc, [...this._path, key], value.toJSON()));
			} else if (value instanceof YText) {
				this.set(key, YText.fromString(this._doc, [...this._path, key], value.toString()));
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
