import { Doc } from "./Doc.js";
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
 * A collaborative text type for rich-text editing.
 * It supports inserting text, deleting text, and applying formatting attributes.
 */
export class YText {
	private _doc: Doc;
	private _path: (string | number)[];
	private _text: string = "";
	private _formatting: FormattingRange[] = [];

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
		return this._text;
	}

	/**
	 * Inserts text at a specified index.
	 * @param index The index at which to insert the text.
	 * @param text The text to insert.
	 */
	insert(index: number, text: string) {
		this._doc.egWalker.localOp({
			type: TEXT_INSERT_OP,
			path: this._path,
			index,
			text,
		});
	}

	/**
	 * Deletes text at a specified index.
	 * @param index The index at which to start deleting.
	 * @param length The number of characters to delete.
	 */
	delete(index: number, length: number) {
		this._doc.egWalker.localOp({
			type: TEXT_DELETE_OP,
			path: this._path,
			index,
			length,
		});
	}

	/**
	 * Applies formatting attributes to a range of text.
	 * @param index The start index of the range.
	 * @param length The length of the range.
	 * @param attributes The formatting attributes to apply.
	 */
	format(index: number, length: number, attributes: Record<string, unknown>) {
		this._doc.egWalker.localOp({
			type: TEXT_FORMAT_OP,
			path: this._path,
			index,
			length,
			attributes,
		});
	}

	/**
	 * Internal method to apply a text insertion from an event.
	 * @param index The index at which to insert.
	 * @param text The text to insert.
	 * @internal
	 */
	_applyInsert(index: number, text: string) {
		this._text = this._text.slice(0, index) + text +
			this._text.slice(index);
		// Shift formatting ranges that start at or after the insertion point.
		for (const range of this._formatting) {
			if (range.index >= index) {
				range.index += text.length;
			} else if (range.index + range.length > index) {
				// Range spans the insertion point — expand it.
				range.length += text.length;
			}
		}
	}

	/**
	 * Internal method to apply a text deletion from an event.
	 * @param index The index at which to start deleting.
	 * @param length The number of characters to delete.
	 * @internal
	 */
	_applyDelete(index: number, length: number) {
		this._text = this._text.slice(0, index) +
			this._text.slice(index + length);
		// Adjust formatting ranges affected by the deletion.
		this._formatting = this._formatting
			.map((range) => {
				if (range.index >= index + length) {
					// Range is entirely after the deletion — shift back.
					return { ...range, index: range.index - length };
				} else if (range.index + range.length <= index) {
					// Range is entirely before the deletion — unchanged.
					return range;
				} else {
					// Range overlaps with the deletion — shrink or remove.
					const overlapStart = Math.max(range.index, index);
					const overlapEnd = Math.min(
						range.index + range.length,
						index + length,
					);
					const overlapLength = overlapEnd - overlapStart;
					const newLength = range.length - overlapLength;
					const newIndex = range.index < index ? range.index : index;
					if (newLength <= 0) return null;
					return { ...range, index: newIndex, length: newLength };
				}
			})
			.filter((r): r is FormattingRange => r !== null);
	}

	/**
	 * Internal method to apply formatting from an event.
	 * @param index The start index of the range.
	 * @param length The length of the range.
	 * @param attributes The formatting attributes to apply.
	 * @internal
	 */
	_applyFormat(
		index: number,
		length: number,
		attributes: Record<string, unknown>,
	) {
		this._formatting.push({ index, length, attributes });
	}

	/**
	 * Gets the formatting ranges applied to this text.
	 * @returns A copy of the formatting ranges array.
	 */
	getFormatting(): FormattingRange[] {
		return [...this._formatting];
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
		ytext._text = text;
		return ytext;
	}
}
