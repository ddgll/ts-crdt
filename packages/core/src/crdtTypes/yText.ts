import { Doc } from "./doc.js";
import {
	TEXT_DELETE_OP,
	TEXT_FORMAT_OP,
	TEXT_INSERT_OP,
	compareEventIds,
} from "../eventGraph/eventGraph.js";

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
}

/**
 * A collaborative text type for rich-text editing.
 * It supports inserting text, deleting text, and applying formatting attributes.
 * 
 * **Note on Concurrency**: YText resolves concurrent index-based operations
 * via deterministic event replay using RGA-like stable IDs, preserving user intent.
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
			type: TEXT_INSERT_OP,
			path: this._path,
			afterId,
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
	_applyInsert(eventId: string, afterId: string | null, text: string): () => void {
		let insertIdx = 0;
		if (afterId !== null) {
			const idx = this._idIndex.get(afterId);
			if (idx !== undefined) {
				insertIdx = idx + 1;
				// RGA tie-breaking: skip past siblings with smaller event IDs
				while (insertIdx < this._data.length) {
					const siblingBaseId = this._data[insertIdx].id.split(':').slice(0, 2).join(':');
					if (compareEventIds(siblingBaseId, eventId) < 0) {
						insertIdx++;
					} else {
						break;
					}
				}
			} else {
				insertIdx = this._data.length;
			}
		}

		const newItems: YTextItem[] = [];
		for (let i = 0; i < text.length; i++) {
			newItems.push({
				id: `${eventId}:${i}`,
				char: text[i],
				isDeleted: false,
				attributes: {}
			});
		}

		this._data.splice(insertIdx, 0, ...newItems);
		for (let i = insertIdx; i < this._data.length; i++) {
			this._idIndex.set(this._data[i].id, i);
		}

		const insertedIds = newItems.map(item => item.id);
		return () => {
			this._data = this._data.filter(item => !insertedIds.includes(item.id));
			this._idIndex.clear();
			for (let i = 0; i < this._data.length; i++) {
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
	 */
	gc() {
		this._data = this._data.filter(item => !item.isDeleted);
		this._idIndex.clear();
		for (let i = 0; i < this._data.length; i++) {
			this._idIndex.set(this._data[i].id, i);
		}
	}

	/**
	 * Creates a YText instance from a plain string.
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
		ytext._applyInsert(`snapshot:${path.join('.')}`, null, text);
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
		ytext._data = (snapshot as any[]).map((item) => ({
			id: item.id,
			char: item.char,
			isDeleted: item.isDeleted,
			attributes: { ...item.attributes }
		}));
		for (let i = 0; i < ytext._data.length; i++) {
			ytext._idIndex.set(ytext._data[i].id, i);
		}
		return ytext;
	}
}
