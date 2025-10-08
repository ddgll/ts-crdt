import { Doc } from './Doc.js';
import { TEXT_INSERT_OP, TEXT_FORMAT_OP } from '../eventGraph/eventGraph.js';

/**
 * A collaborative text type for rich-text editing.
 * It supports inserting text and applying formatting attributes.
 * Note: The current implementation of YText is a basic representation and does not handle formatting attributes yet.
 */
export class YText {
	private _doc: Doc;
	private _path: (string | number)[];
	private _text: string = '';

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
		this._text = this._text.slice(0, index) + text + this._text.slice(index);
	}

	/**
	 * Creates a YText instance from a plain string.
	 * @param doc The parent document.
	 * @param path The path of the text within the document.
	 * @param text The initial string content.
	 * @returns A new YText instance.
	 * @internal
	 */
	static fromString(doc: Doc, path: (string | number)[], text: string): YText {
		const ytext = new YText(doc, path);
		ytext._text = text;
		return ytext;
	}
}