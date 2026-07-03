import { Doc } from "./doc.js";
import {
	TEXT_DELETE_OP,
	TEXT_FORMAT_OP,
	TEXT_INSERT_OP,
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

	/**
	 * Creates a new YText instance.
	 * @param doc The parent document.
	 * @param path The path of the text within the document.
	 * @internal
	 */
	constructor(doc: Doc, path: (string | number)[]) {
		this._doc = doc;
		this._path = path;
	}

	/**
	 * Returns the string representation of the text.
	 * @returns The plain text content.
	 */
	toString(): string {
		let result = "";
		for (const item of this._data) {
			if (!item.isDeleted) {
				result += item.char;
			}
		}
		return result;
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
	 * @internal
	 */
	_applyInsert(eventId: string, afterId: string | null, text: string) {
		let insertIdx = 0;
		if (afterId !== null) {
			const idx = this._data.findIndex(item => item.id === afterId);
			if (idx !== -1) {
				insertIdx = idx + 1;
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
	}

	/**
	 * Internal method to apply a text deletion from an event.
	 * @param targetIds The IDs of the characters to delete.
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
	 * Internal method to apply formatting from an event.
	 * @param targetIds The IDs of the characters to format.
	 * @param attributes The formatting attributes to apply.
	 * @internal
	 */
	_applyFormat(
		targetIds: string[],
		attributes: Record<string, unknown>,
	) {
		const targetSet = new Set(targetIds);
		for (const item of this._data) {
			if (targetSet.has(item.id)) {
				item.attributes = { ...item.attributes, ...attributes };
			}
		}
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
}
