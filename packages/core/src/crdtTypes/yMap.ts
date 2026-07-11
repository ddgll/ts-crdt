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
	 * @param eventId The event ID (used for last-writer-wins conflict resolution).
	 * @returns An undo closure.
	 * @internal
	 */
	_applyDelete(key: string, eventId: string): () => void {
		const existing = this._map.get(key);
		const capturedValue = existing?.value;
		const capturedEventId = existing?.eventId;
		const didExist = existing !== undefined;

		let applied = false;
		if (!existing || !existing.eventId || compareEventIds(eventId, existing.eventId) >= 0) {
			this._map.set(key, { value: undefined, eventId });
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
	 * Gets the wrapper for a key, exposing the value and eventId.
	 * @internal
	 */
	_getWrapper(key: string): { value: unknown; eventId?: string } | undefined {
		return this._map.get(key);
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
			if (value === undefined) continue;
			if (value instanceof YMap) {
				obj[key] = { __crdt_type: "YMap", data: value.toJSON() };
			} else if (value instanceof YArray) {
				obj[key] = { __crdt_type: "YArray", data: value.toJSON() };
			} else if (value instanceof YText) {
				obj[key] = { __crdt_type: "YText", data: value.toString() };
			} else {
				obj[key] = value;
			}
		}
		return obj;
	}

	/**
	 * Serializes the map and its nested CRDTs to a snapshot format that preserves CRDT metadata.
	 * @returns A raw representation of the map.
	 */
	toSnapshot(): Record<string, unknown> {
		const obj: { [key: string]: unknown } = {};
		for (const [key, wrapper] of this._map.entries()) {
			const value = wrapper.value;
			let snapValue: unknown;
			if (value instanceof YMap) {
				snapValue = { __crdt_type: "YMap", data: value.toSnapshot() };
			} else if (value instanceof YArray) {
				snapValue = { __crdt_type: "YArray", data: value.toSnapshot() };
			} else if (value instanceof YText) {
				snapValue = { __crdt_type: "YText", data: value.toSnapshot() };
			} else {
				snapValue = value;
			}
			obj[key] = { value: snapValue, eventId: wrapper.eventId };
		}
		return obj;
	}

	/**
	 * Performs garbage collection by recursively calling gc() on nested CRDT collections.
	 * 
	 * WARNING: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization.
	 * It should only be called when all clients are guaranteed to receive a synchronized snapshot to prevent permanent replica divergence.
	 * 
	 * @param force Must be explicitly set to true to execute garbage collection.
	 */
	gc(force: boolean = false) {
		if (!force) {
			throw new Error("Garbage collection must be explicitly forced by passing true (e.g. gc(true)). Warning: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization if clients are not fully synchronized via snapshots.");
		}
		for (const wrapper of this._map.values()) {
			const value = wrapper.value;
			if (value instanceof YMap || value instanceof YArray || value instanceof YText) {
				value.gc(force);
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
			const value = json[key];
			if (isRecord(value) && "__crdt_type" in value) {
				const __crdt_type = value.__crdt_type;
				const data = value.data;
				switch (__crdt_type) {
					case "YMap":
						if (isRecord(data)) {
							map._applySet(
								key,
								YMap.fromJSON(
									doc,
									[...path, key],
									data,
								),
							);
						}
						break;
					case "YArray":
						if (isUnknownArray(data)) {
							map._applySet(
								key,
								YArray.fromJSON(
									doc,
									[...path, key],
									data,
								),
							);
						}
						break;
					case "YText":
						if (isString(data)) {
							map._applySet(
								key,
								YText.fromString(
									doc,
									[...path, key],
									data,
								),
							);
						}
						break;
				}
			} else {
				map._applySet(key, value);
			}
		}
		return map;
	}

	/**
	 * Creates a YMap instance from a snapshot object.
	 * @param doc The parent document.
	 * @param path The path of the map within the document.
	 * @param snapshot The snapshot object to deserialize.
	 * @returns A new YMap instance with the deserialized data.
	 * @internal
	 */
	static fromSnapshot(
		doc: Doc,
		path: (string | number)[],
		snapshot: Record<string, unknown>,
	): YMap {
		const map = new YMap(doc, path);
		for (const key in snapshot) {
			const wrapper = snapshot[key];
			if (!isSnapshotWrapper(wrapper)) continue;
			const value = wrapper.value;
			let parsedValue = value;
			if (isRecord(value) && "__crdt_type" in value) {
				const __crdt_type = value.__crdt_type;
				const data = value.data;
				switch (__crdt_type) {
					case "YMap":
						if (isRecord(data)) {
							parsedValue = YMap.fromSnapshot(
								doc,
								[...path, key],
								data,
							);
						}
						break;
					case "YArray":
						if (isUnknownArray(data)) {
							parsedValue = YArray.fromSnapshot(
								doc,
								[...path, key],
								data,
							);
						}
						break;
					case "YText":
						if (isUnknownArray(data)) {
							parsedValue = YText.fromSnapshot(
								doc,
								[...path, key],
								data,
							);
						}
						break;
				}
			}
			map._map.set(key, { value: parsedValue, eventId: wrapper.eventId });
		}
		return map;
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

function isSnapshotWrapper(val: unknown): val is { value: unknown; eventId?: string } {
	return isRecord(val) && (typeof val.eventId === "string" || val.eventId === undefined);
}
