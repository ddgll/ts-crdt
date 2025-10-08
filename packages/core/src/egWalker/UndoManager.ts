import { EgWalker } from './egWalker.js';
import { EventID } from '../eventGraph/eventGraph.js';

/**
 * Manages the undo/redo history for a document by tracking versions in the event graph.
 * It allows for non-destructive history traversal.
 */
export class UndoManager {
	private walker: EgWalker;
	/** A stack of document versions to which the user can undo. */
	private undoStack: EventID[][] = [];
	/** A stack of document versions to which the user can redo. */
	private redoStack: EventID[][] = [];

	/**
	 * Creates a new UndoManager.
	 * @param walker The `EgWalker` instance associated with the document.
	 */
	constructor(walker: EgWalker) {
		this.walker = walker;
	}

	/**
	 * Creates a snapshot of the current document version and pushes it onto the undo stack.
	 * This should be called after a user action that should be undoable.
	 * Any new track clears the redo stack.
	 */
	public track() {
		const currentVersion = this.walker.getVersion();
		this.undoStack.push(currentVersion);
		this.redoStack = []; // Clear redo stack on new action
	}

	/**
	 * Reverts the document to the state of the previous version on the undo stack.
	 * The reverted version is moved to the redo stack.
	 */
	public undo() {
		if (this.undoStack.length === 0) {
			return;
		}

		const undoneVersion = this.undoStack.pop()!;
		this.redoStack.push(undoneVersion);

		const versionToRestore =
			this.undoStack.length > 0
				? this.undoStack[this.undoStack.length - 1]
				: []; // If stack is empty, restore to initial state
		this.walker.rebuildStateAtVersion(versionToRestore);
	}

	/**
	 * Restores the most recently undone version from the redo stack.
	 * The restored version is moved back to the undo stack.
	 */
	public redo() {
		if (this.redoStack.length === 0) {
			return;
		}

		const versionToRestore = this.redoStack.pop()!;
		this.undoStack.push(versionToRestore);
		this.walker.rebuildStateAtVersion(versionToRestore);
	}
}