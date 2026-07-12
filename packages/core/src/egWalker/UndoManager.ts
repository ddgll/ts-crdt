import { EgWalker } from './egWalker.js';
import {
	ARRAY_DELETE_OP,
	ARRAY_INSERT_OP,
	CrdtEvent,
	MAP_DELETE_OP,
	MAP_SET_OP,
	Op,
	TEXT_DELETE_OP,
	TEXT_INSERT_OP,
} from '../eventGraph/eventGraph.js';
import { YMap } from '../crdtTypes/yMap.js';
import { YArray } from '../crdtTypes/yArray.js';
import { YText } from '../crdtTypes/yText.js';

type Container = YMap | YArray | YText;

/**
 * Manages undo/redo for a document using an **inverse-operation** model.
 *
 * Rather than rewinding the document to a historical version — which drags
 * undone local edits back whenever a remote edit causally descends from them —
 * an undo computes the inverse of each undoable local operation and applies it
 * as a *new* event. Because the inverse is an ordinary operation that replicates
 * like any other, undo commutes with concurrent remote edits: undoing a local
 * change removes exactly that change and nothing else, even when remote events
 * build on top of it.
 *
 * Local operations are captured as they happen (via {@link EgWalker.onBeforeLocalApply}),
 * grouped between {@link track} calls, and inverted at {@link undo} time against
 * the live document state.
 *
 * Limitations: operations whose effect cannot be expressed as a single inverse
 * operation are skipped by undo. These are: text formatting (a format merges
 * attributes and cannot be cleanly removed), overwriting or deleting a value
 * that held a nested container (a container instance cannot travel inside an
 * operation), and snapshot loads. Undoing an array/text delete revives the
 * content as a *new* insertion (new element/character identities), which is the
 * standard behavior for operation-based undo.
 */
export class UndoManager {
	private walker: EgWalker;
	/** Stack of groups; each group is the inverse ops to apply to undo it. */
	private undoStack: Op[][] = [];
	/** Stack of groups; each group is the ops to apply to redo it. */
	private redoStack: Op[][] = [];
	/** Inverses of local ops observed since the last {@link track} boundary. */
	private currentGroup: Op[] = [];
	/**
	 * While the manager is itself applying ops (during undo/redo), captured
	 * inverses are routed here instead of into {@link currentGroup}, so an undo's
	 * own events populate the redo stack rather than being treated as user edits.
	 */
	private captureTarget: Op[] | null = null;
	private unsubscribe: () => void;

	/**
	 * Creates a new UndoManager.
	 * @param walker The `EgWalker` instance associated with the document.
	 */
	constructor(walker: EgWalker) {
		this.walker = walker;
		this.unsubscribe = walker.onBeforeLocalApply((event) =>
			this.onBeforeLocalApply(event),
		);
	}

	/**
	 * Stops observing local operations. Call when the manager is no longer needed.
	 */
	public destroy() {
		this.unsubscribe();
	}

	/**
	 * Observes a local event before it is applied, capturing its inverse while the
	 * document still reflects the pre-operation state.
	 */
	private onBeforeLocalApply(event: CrdtEvent) {
		const inverse = this.computeInverse(event);
		if (this.captureTarget) {
			if (inverse) this.captureTarget.unshift(inverse);
			return;
		}
		// A fresh user operation invalidates any pending redo history.
		this.redoStack = [];
		if (inverse) this.currentGroup.unshift(inverse);
	}

	/**
	 * Closes the current group of local operations, making it a single undoable
	 * unit. Operations performed since the previous `track()` become that unit.
	 * A no-op if no undoable operations have been performed since the last call.
	 */
	public track() {
		if (this.currentGroup.length === 0) {
			return;
		}
		this.undoStack.push(this.currentGroup);
		this.currentGroup = [];
		this.redoStack = [];
	}

	/**
	 * Undoes the most recent group of local operations by applying their inverse
	 * operations as new events. Remote edits — including those that causally
	 * follow the undone operations — are left untouched.
	 */
	public undo() {
		// Any operations performed since the last track() form an implicit group.
		if (this.currentGroup.length > 0) {
			this.undoStack.push(this.currentGroup);
			this.currentGroup = [];
		}
		if (this.undoStack.length === 0) {
			return;
		}
		const inverseOps = this.undoStack.pop()!;
		const redoOps = this.applyOps(inverseOps);
		this.redoStack.push(redoOps);
	}

	/**
	 * Re-applies the most recently undone group by applying its operations as new
	 * events.
	 */
	public redo() {
		if (this.redoStack.length === 0) {
			return;
		}
		const redoOps = this.redoStack.pop()!;
		const undoOps = this.applyOps(redoOps);
		this.undoStack.push(undoOps);
	}

	/**
	 * Applies the given operations as fresh local events, capturing the inverse of
	 * each so the reverse direction can be replayed. Returns the captured inverses
	 * ordered so they can be applied as a single revert group.
	 */
	private applyOps(ops: Op[]): Op[] {
		const captured: Op[] = [];
		const previousTarget = this.captureTarget;
		this.captureTarget = captured;
		try {
			for (const op of ops) {
				this.walker.localOp(op);
			}
		} finally {
			this.captureTarget = previousTarget;
		}
		return captured;
	}

	/**
	 * Computes the inverse operation for a local event, read against the current
	 * (pre-application) document state. Returns null when the operation cannot be
	 * inverted with a single operation (see class-level limitations).
	 */
	private computeInverse(event: CrdtEvent): Op | null {
		const op = event.op;
		switch (op.type) {
			case MAP_SET_OP: {
				const target = this.resolveTarget(op.path);
				if (!(target instanceof YMap)) return null;
				const wrapper = target._getWrapper(op.key);
				const old = wrapper?.value;
				if (wrapper === undefined || old === undefined) {
					return { type: MAP_DELETE_OP, path: op.path, key: op.key };
				}
				if (isContainer(old)) return null;
				return { type: MAP_SET_OP, path: op.path, key: op.key, value: old };
			}
			case MAP_DELETE_OP: {
				const target = this.resolveTarget(op.path);
				if (!(target instanceof YMap)) return null;
				const old = target._getWrapper(op.key)?.value;
				if (old === undefined || isContainer(old)) return null;
				return { type: MAP_SET_OP, path: op.path, key: op.key, value: old };
			}
			case ARRAY_INSERT_OP: {
				const targetIds = op.values.map((_, i) => `${event.id}:${i}`);
				return { type: ARRAY_DELETE_OP, path: op.path, targetIds };
			}
			case TEXT_INSERT_OP: {
				const targetIds: string[] = [];
				for (let i = 0; i < op.text.length; i++) {
					targetIds.push(`${event.id}:${i}`);
				}
				return { type: TEXT_DELETE_OP, path: op.path, targetIds };
			}
			case ARRAY_DELETE_OP: {
				const target = this.resolveTarget(op.path);
				if (!(target instanceof YArray)) return null;
				const cap = target._captureReinsert(op.targetIds);
				if (!cap || cap.values.length === 0 || cap.values.some(isContainer)) {
					return null;
				}
				return {
					type: ARRAY_INSERT_OP,
					path: op.path,
					afterId: cap.afterId,
					values: cap.values,
				};
			}
			case TEXT_DELETE_OP: {
				const target = this.resolveTarget(op.path);
				if (!(target instanceof YText)) return null;
				const cap = target._captureReinsert(op.targetIds);
				if (!cap || cap.text.length === 0) return null;
				return {
					type: TEXT_INSERT_OP,
					path: op.path,
					afterId: cap.afterId,
					text: cap.text,
				};
			}
			// TEXT_FORMAT_OP and SNAPSHOT_OP are intentionally not undoable.
			default:
				return null;
		}
	}

	/**
	 * Resolves the container an operation targets by walking its path from the
	 * document root, mirroring the walker's own path traversal.
	 */
	private resolveTarget(path: (string | number)[]): Container | undefined {
		let current: Container = this.walker.getDocument().getMap();
		for (const key of path) {
			let next: unknown;
			if (current instanceof YMap) {
				next = current._getWrapper(String(key))?.value;
			} else if (current instanceof YArray) {
				next = current.get(Number(key));
			} else {
				return undefined;
			}
			if (!isContainer(next)) return undefined;
			current = next;
		}
		return current;
	}
}

function isContainer(value: unknown): value is Container {
	return (
		value instanceof YMap || value instanceof YArray || value instanceof YText
	);
}
