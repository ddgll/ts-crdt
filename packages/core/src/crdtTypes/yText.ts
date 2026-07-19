import { Doc } from "./doc.js";
import {
	TEXT_DELETE_OP,
	TEXT_FORMAT_OP,
	TEXT_INSERT_OP,
} from "../eventGraph/eventGraph.js";
import { rgaInsertIndex } from "./rga.js";

/**
 * Represents a formatting range applied to the text.
 */
interface FormattingRange {
	/** The start index of the range. */
	index: number;
	/** The length of the range. */
	length: number;
	/** The formatting attributes applied to this range. */
	attributes: Record<string, unknown>;
}

/**
 * Internal representation of a character in the YText.
 */
interface YTextItem {
	id: string;
	char: string;
	isDeleted: boolean;
	attributes: Record<string, unknown>;
	/** Id of the left neighbour at insert time (YATA left origin), or null at the head. */
	originId: string | null;
	/** Id of the right neighbour at insert time (YATA right origin), or null at the tail. */
	rightOriginId: string | null;
}

/**
 * A collaborative text type for rich-text editing.
 * It supports inserting text, deleting text, and applying formatting attributes.
 * 
 * **Note on Concurrency**: YText converges by deterministic total-order replay,
 * integrating inserts with a right-origin (YATA-style) rule shared via
 * {@link rgaInsertIndex} so interior insertions land correctly and concurrently
 * typed runs are not interleaved. All replicas reach byte-identical results.
 *
 * **Note on Unicode**: indices and lengths are in UTF-16 code units (like Yjs
 * and JavaScript strings), and each code unit is a separately addressable RGA
 * item. A `delete`/`format` range that starts or ends inside a surrogate pair
 * therefore addresses half a pair; this is consistent across all replicas (no
 * divergence) but can produce an ill-formed lone surrogate in {@link toString}.
 * Callers editing astral characters (emoji, etc.) should snap ranges to
 * code-point boundaries. Higher-level helpers such as `CrdtClient.syncText`
 * already diff on code-point boundaries to avoid this.
 */
export class YText {
	private _doc: Doc;
	private _path: (string | number)[];
	private _data: YTextItem[] = [];
	private _idIndex: Map<string, number>;

	/**
	 * Creates a new YText instance.
	 * @param doc The parent document.
	 * @param path The path of the text within the document.
	 * @internal
	 */
	constructor(doc: Doc, path: (string | number)[]) {
		this._doc = doc;
		this._path = path;
		this._idIndex = new Map();
	}

	/**
	 * Returns the string representation of the text.
	 * @returns The plain text content.
	 */
	toString(): string {
		const chars: string[] = [];
		for (const item of this._data) {
			if (!item.isDeleted) {
				chars.push(item.char);
			}
		}
		return chars.join('');
	}

	/**
	 * Serializes the text and its formatting to a snapshot format that preserves CRDT metadata.
	 * @returns A raw representation of the text.
	 */
	toSnapshot(): unknown[] {
		return this._data.map(item => ({ ...item, attributes: { ...item.attributes } }));
	}

	/**
	 * Inserts text at a specified index.
	 * @param index The index at which to insert the text.
	 * @param text The text to insert.
	 */
	insert(index: number, text: string) {
		if (text.length === 0) return;
		// Capture both the left neighbour (`afterId`) and the right neighbour
		// (`beforeId`) visible at the insertion point, so the insert is bounded on
		// both sides at integration time (YATA/right-origin — see rgaInsertIndex).
		let afterId: string | null = null;
		let beforeId: string | null = null;
		let lastVisibleId: string | null = null;
		let k = 0;
		for (let i = 0; i < this._data.length; i++) {
			if (this._data[i].isDeleted) continue;
			if (k === index - 1) afterId = this._data[i].id;
			if (k === index) {
				beforeId = this._data[i].id;
				break;
			}
			lastVisibleId = this._data[i].id;
			k++;
		}
		// Clamp an out-of-range index to the end rather than silently inserting at
		// the head (afterId/beforeId would otherwise both be null).
		if (index > 0 && afterId === null && beforeId === null) {
			afterId = lastVisibleId;
		}
		this._doc.egWalker.localOp({
			type: TEXT_INSERT_OP,
			path: this._path,
			afterId,
			beforeId,
			text,
		});
	}

	/**
	 * Deletes text at a specified index.
	 * @param index The index at which to start deleting.
	 * @param length The number of characters to delete.
	 */
	delete(index: number, length: number) {
		if (length <= 0) return;
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
				type: TEXT_DELETE_OP,
				path: this._path,
				targetIds,
			});
		}
	}

	/**
	 * Applies formatting attributes to a range of text.
	 * @param index The start index of the range.
	 * @param length The length of the range.
	 * @param attributes The formatting attributes to apply.
	 */
	format(index: number, length: number, attributes: Record<string, unknown>) {
		if (length <= 0) return;
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
				type: TEXT_FORMAT_OP,
				path: this._path,
				targetIds,
				attributes,
			});
		}
	}

	/**
	 * Internal method to apply a text insertion from an event.
	 * @param eventId The ID of the event triggering the insert.
	 * @param afterId The ID of the character to insert after.
	 * @param text The text to insert.
	 * @returns An undo closure.
	 * @internal
	 */
	_applyInsert(eventId: string, afterId: string | null, beforeId: string | null, text: string): () => void {
		// RGA/YATA integration is shared with YArray via rgaInsertIndex so the
		// convergence-critical convention lives in exactly one place.
		const rightOriginId = beforeId ?? null;
		const insertIdx = rgaInsertIndex(this._data, this._idIndex, afterId, rightOriginId, eventId);

		const newItems: YTextItem[] = [];
		const lastIdx = text.length - 1;
		for (let i = 0; i < text.length; i++) {
			newItems.push({
				id: `${eventId}:${i}`,
				char: text[i],
				isDeleted: false,
				attributes: {},
				// Within a run each character's origins are its run-neighbours; the
				// run's outer boundaries carry the op's afterId/beforeId.
				originId: i === 0 ? afterId : `${eventId}:${i - 1}`,
				rightOriginId: i === lastIdx ? rightOriginId : `${eventId}:${i + 1}`,
			});
		}

		this._data.splice(insertIdx, 0, ...newItems);
		for (let i = insertIdx; i < this._data.length; i++) {
			this._idIndex.set(this._data[i].id, i);
		}

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
		};
	}

	/**
	 * Internal method to apply a text deletion from an event.
	 * @param targetIds The IDs of the characters to delete.
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
					toggledIds.push(id);
				}
			}
		}

		return () => {
			for (const id of toggledIds) {
				const idx = this._idIndex.get(id);
				if (idx !== undefined) {
					this._data[idx].isDeleted = false;
				}
			}
		};
	}

	/**
	 * Internal method to apply formatting from an event.
	 * @param targetIds The IDs of the characters to format.
	 * @param attributes The formatting attributes to apply.
	 * @returns An undo closure.
	 * @internal
	 */
	_applyFormat(
		targetIds: string[],
		attributes: Record<string, unknown>,
	): () => void {
		const oldAttributes: { id: string, attrs: Record<string, unknown> }[] = [];
		for (const id of targetIds) {
			const idx = this._idIndex.get(id);
			if (idx !== undefined) {
				oldAttributes.push({ id, attrs: { ...this._data[idx].attributes } });
				this._data[idx].attributes = { ...this._data[idx].attributes, ...attributes };
			}
		}

		return () => {
			for (const { id, attrs } of oldAttributes) {
				const idx = this._idIndex.get(id);
				if (idx !== undefined) {
					this._data[idx].attributes = attrs;
				}
			}
		};
	}

	/**
	 * Captures the parameters needed to re-insert the given characters, for undoing
	 * a delete. Reads the current internal order so the revived text is placed back
	 * after the same predecessor. Must be called while the target characters are
	 * still present (i.e. before the delete is applied, or against a tombstone that
	 * has not been garbage-collected).
	 * @param targetIds The ids of the characters whose content should be revived.
	 * @returns The anchor id and text for a {@link TEXT_INSERT_OP}, or null if none
	 *   of the targets are present.
	 * @internal
	 */
	_captureReinsert(targetIds: string[]): { afterId: string | null; beforeId: string | null; text: string } | null {
		const idSet = new Set(targetIds);
		let firstIdx = -1;
		let lastIdx = -1;
		let text = "";
		for (let i = 0; i < this._data.length; i++) {
			if (idSet.has(this._data[i].id)) {
				if (firstIdx === -1) firstIdx = i;
				lastIdx = i;
				text += this._data[i].char;
			}
		}
		if (firstIdx === -1) return null;
		const afterId = firstIdx > 0 ? this._data[firstIdx - 1].id : null;
		const beforeId = lastIdx < this._data.length - 1 ? this._data[lastIdx + 1].id : null;
		return { afterId, beforeId, text };
	}

	/**
	 * Gets the formatting ranges applied to this text.
	 * Reconstructs continuous ranges of identical formatting.
	 * @returns A copy of the formatting ranges array.
	 */
	getFormatting(): FormattingRange[] {
		const ranges: FormattingRange[] = [];
		let currentIndex = 0;
		let currentRange: FormattingRange | null = null;

		for (const item of this._data) {
			if (item.isDeleted) continue;

			const hasAttributes = Object.keys(item.attributes).length > 0;
			
			if (hasAttributes) {
				if (!currentRange) {
					currentRange = {
						index: currentIndex,
						length: 1,
						attributes: { ...item.attributes }
					};
				} else {
					// Check if attributes match exactly
					const attrs1 = currentRange.attributes;
					const attrs2 = item.attributes;
					const keys1 = Object.keys(attrs1);
					const keys2 = Object.keys(attrs2);
					let match = keys1.length === keys2.length;
					if (match) {
						for (const k of keys1) {
							if (attrs1[k] !== attrs2[k]) {
								match = false;
								break;
							}
						}
					}

					if (match) {
						currentRange.length++;
					} else {
						ranges.push(currentRange);
						currentRange = {
							index: currentIndex,
							length: 1,
							attributes: { ...item.attributes }
						};
					}
				}
			} else {
				if (currentRange) {
					ranges.push(currentRange);
					currentRange = null;
				}
			}
			currentIndex++;
		}
		if (currentRange) {
			ranges.push(currentRange);
		}
		return ranges;
	}

	/**
	 * Performs garbage collection by cleanly splicing out characters marked as deleted.
	 *
	 * WARNING: Calling gc() permanently deletes tombstones and can cause CRDT desynchronization.
	 * It should only be called when all clients are guaranteed to receive a synchronized snapshot to prevent permanent replica divergence.
	 *
	 * Tombstoned characters double as RGA insertion anchors (`rgaInsertIndex`
	 * resolves an insert's position by locating its `afterId` in `_data`). A
	 * tombstone is therefore only safe to remove when it is causally stable AND no
	 * not-yet-folded event still references it as an anchor; otherwise that event
	 * would fall back to append-at-end and silently reorder text. See PLAN_10.
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
		}
	}

	/**
	 * Creates a YText instance from a plain string.
	 *
	 * **LOSSY / NON-COLLABORATIVE:** all characters share a single synthetic
	 * path-derived anchor id (`snapshot:<path>`), which is not globally unique
	 * across replicas. A string-loaded text cannot be safely used in a
	 * collaborative sync flow — use {@link YText.fromSnapshot} (which preserves
	 * real per-character ids and tombstones) for that. See {@link Doc.fromJSON}.
	 * @param doc The parent document.
	 * @param path The path of the text within the document.
	 * @param text The initial string content.
	 * @returns A new YText instance.
	 * @internal
	 */
	static fromString(
		doc: Doc,
		path: (string | number)[],
		text: string,
	): YText {
		const ytext = new YText(doc, path);
		ytext._applyInsert(`snapshot:${path.join('.')}`, null, null, text);
		return ytext;
	}

	/**
	 * Creates a YText instance from a snapshot object.
	 * @param doc The parent document.
	 * @param path The path of the text within the document.
	 * @param snapshot The snapshot object to deserialize.
	 * @returns A new YText instance with the deserialized data.
	 * @internal
	 */
	static fromSnapshot(
		doc: Doc,
		path: (string | number)[],
		snapshot: unknown[],
	): YText {
		const ytext = new YText(doc, path);
		ytext._data = snapshot.map((item) => {
			if (!isYTextSnapshotItem(item)) return { id: "", char: "", isDeleted: true, attributes: {}, originId: null, rightOriginId: null };
			return {
				id: item.id,
				char: item.char,
				isDeleted: item.isDeleted,
				attributes: { ...item.attributes },
				// Legacy snapshots predate right-origin metadata; default to null so
				// they still integrate deterministically after loading.
				originId: typeof item.originId === "string" ? item.originId : null,
				rightOriginId: typeof item.rightOriginId === "string" ? item.rightOriginId : null,
			};
		});
		for (let i = 0; i < ytext._data.length; i++) {
			ytext._idIndex.set(ytext._data[i].id, i);
		}
		return ytext;
	}
}

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isYTextSnapshotItem(val: unknown): val is { id: string, char: string, isDeleted: boolean, attributes: Record<string, unknown>, originId?: unknown, rightOriginId?: unknown } {
	return isRecord(val) && typeof val.id === "string" && typeof val.char === "string" && typeof val.isDeleted === "boolean" && isRecord(val.attributes);
}
