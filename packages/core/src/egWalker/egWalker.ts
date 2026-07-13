import {
	ARRAY_DELETE_OP,
	ARRAY_INSERT_OP,
	CrdtEvent,
	EventGraph,
	EventID,
	MAP_SET_OP,
	MAP_DELETE_OP,
	Op,
	SNAPSHOT_OP,
	TEXT_DELETE_OP,
	TEXT_FORMAT_OP,
	TEXT_INSERT_OP,
	compareEventIds,
} from "../eventGraph/eventGraph.js";
import { Doc } from "../crdtTypes/doc.js";
import { YMap } from "../crdtTypes/yMap.js";
import { YArray } from "../crdtTypes/yArray.js";
import { YText } from "../crdtTypes/yText.js";
import { Logger, getLogger } from "../logger.js";

/**
 * Generates a strong, collision-resistant default replica id.
 *
 * Prefers `crypto.randomUUID()` (cryptographically strong, 122 random bits) so
 * two replicas practically never share an id namespace — a collision would let
 * them mint duplicate event ids, which `EventGraph.addEvent` silently drops,
 * causing divergence. Falls back to a `Math.random`-based id only where the Web
 * Crypto API is unavailable. The result never contains ':' so it is safe as the
 * `replicaId` half of a `replicaId:sequence` event id.
 */
export function generateReplicaId(): string {
	const cryptoObj: Crypto | undefined =
		typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
	if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
		return cryptoObj.randomUUID();
	}
	// Fallback: combine two Math.random draws for a longer, lower-collision id.
	return (
		Math.random().toString(36).substring(2, 15) +
		Math.random().toString(36).substring(2, 15)
	);
}

/**
 * Represents a snapshot of the document's state, including the data, event graph, and replica information.
 */
export interface StateSnapshot {
	/** The JSON representation of the document's data. */
	doc: Record<string, unknown>;
	/** The event graph, serialized as an array of events. */
	graph: { events: [EventID, CrdtEvent][] };
	/** The ID of the replica that created the snapshot. */
	replicaId: string | null;
	/** The last sequence number used by the replica. */
	sequenceNumber: number;
}

/**
 * Custom error class for errors originating from the EgWalker.
 */
export class EgWalkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EgWalkerError";
	}
}

/**
 * The core engine for processing and applying CRDT events. It manages the
 * event graph, replica state, and document modifications.
 *
 * **On the name.** "EgWalker" is short for "Event Graph Walker" and refers to
 * the event-graph *data structure* this class walks — it is **not** an
 * implementation of the Eg-walker algorithm (Kleppmann/Gentle, "Collaborative
 * Text Editing with Eg-walker"), whose purpose is to avoid the RGA
 * interleaving anomaly.
 *
 * **How convergence actually works.** All replicas reach Strong Eventual
 * Consistency by *deterministic total-order replay*, not by the Eg-walker
 * algorithm:
 *  1. Every event is kept in a DAG.
 *  2. Events are placed in one global total order sorted by event id
 *     (`compareEventIds`: Lamport sequence first, then replicaId). An
 *     incremental fast path re-applies only the changed suffix; a lower-Lamport
 *     event arriving late triggers a re-sort and suffix re-apply.
 *  3. Ops are replayed in that order, resolving maps with LWW and arrays/text
 *     with RGA index resolution keyed on stable ids.
 *
 * Because every replica runs the identical sequence over identical state, they
 * converge on byte-identical results. Concurrent inserts sharing an anchor
 * settle in ascending event-id order (the RGA tie-break) and **may interleave**
 * — this inherits RGA's behavior, so the interleaving anomaly is possible and
 * user intent is *not* guaranteed to be preserved for concurrent runs. If
 * non-interleaving prose editing matters, that is a feature gap to track
 * separately (adopt Eg-walker/Fugue-style insertion), not a bug.
 */
export class EgWalker {
	private doc: Doc;
	/** The underlying event graph instance. */
	public graph: EventGraph;
	private replicaId: string;
	/**
	 * The replica's Lamport logical clock, stored as "the next sequence number to
	 * assign". It is advanced past the sequence number of every observed event
	 * (local or remote) so that the numeric part of each new event id is a Lamport
	 * timestamp — strictly greater than that of every causally-preceding event.
	 * This is what makes `compareEventIds` (seq-first) a causally-consistent order.
	 */
	private sequenceNumber = 0;
	/** A map of awareness states for connected replicas. */
	public awarenessStates = new Map<string, unknown>();
	private eventListeners = new Set<(event: CrdtEvent, isLocal: boolean) => void>();
	private beforeLocalApplyListeners = new Set<(event: CrdtEvent) => void>();
	private cachedSortedEvents: CrdtEvent[] = [];
	private undoStack = new Map<EventID, () => void>();
	private isAtHead = true;
	/**
	 * Events received whose parents are not yet all present in the graph.
	 * They are held here and retried on every ingest until their parents arrive,
	 * so integration is tolerant of out-of-order / missing-parent delivery and
	 * never calls `addEvent` with a missing parent (which would throw).
	 */
	private pendingEvents = new Map<EventID, CrdtEvent>();
	/** Logger used for diagnostics; defaults to the process-wide logger. */
	private logger: Logger;

	/**
	 * Registers a callback to be notified when a new event is applied (either locally or integrated from a remote replica).
	 * Returns an unsubscribe function.
	 */
	onEvent(cb: (event: CrdtEvent, isLocal: boolean) => void): () => void {
		this.eventListeners.add(cb);
		return () => {
			this.eventListeners.delete(cb);
		};
	}

	/**
	 * Notifies all registered event listeners with error isolation.
	 * A faulty listener will not prevent other listeners from being called.
	 */
	private notifyListeners(event: CrdtEvent, isLocal: boolean) {
		for (const listener of this.eventListeners) {
			try {
				listener(event, isLocal);
			} catch (err) {
				this.logger.error("[EgWalker] Event listener error:", err);
			}
		}
	}

	/**
	 * Registers a callback invoked for each local event *before* it is applied to
	 * the document, while the document still reflects the pre-operation state.
	 * This lets an observer (e.g. {@link UndoManager}) capture the information
	 * needed to build an inverse operation. Returns an unsubscribe function.
	 */
	onBeforeLocalApply(cb: (event: CrdtEvent) => void): () => void {
		this.beforeLocalApplyListeners.add(cb);
		return () => {
			this.beforeLocalApplyListeners.delete(cb);
		};
	}

	private notifyBeforeLocalApply(event: CrdtEvent) {
		for (const listener of this.beforeLocalApplyListeners) {
			try {
				listener(event);
			} catch (err) {
				this.logger.error("[EgWalker] beforeLocalApply listener error:", err);
			}
		}
	}

	/**
	 * Gets the document this walker is attached to.
	 * @returns The parent {@link Doc}.
	 */
	getDocument(): Doc {
		return this.doc;
	}

	/**
	 * Creates a new EgWalker instance.
	 * @param doc The parent document.
	 * @param replicaId An optional unique identifier for this replica.
	 * @param graph An optional existing event graph to use.
	 */
	constructor(doc: Doc, replicaId?: string, graph = new EventGraph(), logger: Logger = getLogger()) {
		if (replicaId && replicaId.includes(':')) {
			throw new EgWalkerError("replicaId must not contain ':'");
		}
		this.graph = graph;
		this.doc = doc;
		this.logger = logger;
		this.replicaId = replicaId || generateReplicaId();
		this.cachedSortedEvents = this.graph.getSortedEvents();
		this.isAtHead = true;
	}

	/**
	 * Gets the unique identifier of this replica.
	 * @returns The replica ID.
	 */
	getReplicaId(): string {
		return this.replicaId;
	}

	/**
	 * Gets the current version of the document, represented by the heads of the event graph.
	 * @returns An array of event IDs representing the current version.
	 */
	getVersion(): EventID[] {
		return this.graph.getVersion();
	}

	/**
	 * Generates the next Lamport timestamp for a local event.
	 *
	 * Because the clock is advanced on observation of every event (see
	 * `_ingestEvents`), the current value is already greater than the sequence
	 * number of every event this replica has seen — including this event's
	 * parents (the current heads). Returning it and post-incrementing therefore
	 * yields a value that is strictly greater than every causal predecessor and
	 * strictly increasing per replica (guaranteeing id uniqueness).
	 * @returns The next sequence number.
	 */
	private generateNextSequenceNumber(): number {
		return this.sequenceNumber++;
	}

	/**
	 * Advances the Lamport clock past the sequence number of an observed event,
	 * regardless of which replica produced it.
	 */
	private observeSequenceNumber(id: EventID): void {
		const eventSequenceNumber = parseInt(id.split(":")[1], 10);
		if (Number.isFinite(eventSequenceNumber) && eventSequenceNumber >= this.sequenceNumber) {
			this.sequenceNumber = eventSequenceNumber + 1;
		}
	}

	/**
	 * Creates a new local operation, wraps it in an event, and applies it to the document.
	 * @param op The operation to perform.
	 * @returns The newly created event.
	 */
	localOp(op: Op): CrdtEvent {
		const event: CrdtEvent = {
			id: `${this.replicaId}:${this.generateNextSequenceNumber()}`,
			replicaId: this.replicaId,
			parents: this.graph.getVersion(),
			op,
		};
		
		if (!this.isAtHead) {
			this.rebuildStateAtVersion(this.graph.getVersion());
		}

		this.graph.addEvent(event);
		this.cachedSortedEvents = this.graph.getSortedEvents();
		// Notify before-apply observers while the document still holds the
		// pre-operation state, so they can capture inverse-operation data.
		this.notifyBeforeLocalApply(event);
		const undo = this.applyNewEvent(event);
		this.undoStack.set(event.id, undo);
		this.notifyListeners(event, true);
		return event;
	}

	/**
	 * Ingests one or more events into the graph and rebuilds the document state.
	 * Returns the list of events that were actually new (not duplicates).
	 */
	private _ingestEvents(events: CrdtEvent[]): CrdtEvent[] {
		const oldSorted = [...this.cachedSortedEvents];
		const addedEvents: CrdtEvent[] = [];

		// Stage every genuinely-new event into the pending pool. Events already in
		// the graph or already pending are ignored (idempotent integration).
		for (const event of events) {
			if (this.graph.getEvent(event.id)) {
				continue;
			}
			if (this.pendingEvents.has(event.id)) {
				continue;
			}
			this.pendingEvents.set(event.id, event);
		}

		// Integrate every pending event whose parents are all present, repeating
		// until no further progress is made — a newly-integrated event can unblock
		// others. This tolerates out-of-order and missing-parent delivery: an event
		// whose parents never arrive simply stays buffered instead of throwing.
		if (this.pendingEvents.size > 0) {
			let progress = true;
			while (progress) {
				progress = false;
				for (const event of Array.from(this.pendingEvents.values())) {
					const parentsPresent = event.parents.every(
						(p) => this.graph.getEvent(p) !== undefined,
					);
					if (!parentsPresent) continue;

					try {
						this.graph.addEvent(event);
					} catch (err) {
						// Structurally invalid event (bad op type, self-parent, ...).
						// Drop it so a single bad event can neither abort the batch nor be
						// retried forever, leaving the graph half-applied.
						this.logger.error("[EgWalker] Dropping un-integrable event:", event.id, err);
						this.pendingEvents.delete(event.id);
						continue;
					}
					this.pendingEvents.delete(event.id);
					this.observeSequenceNumber(event.id);
					addedEvents.push(event);
					progress = true;
				}
			}
		}

		if (addedEvents.length > 0) {
			const newSorted = this.graph.getSortedEvents();
			let diffIndex = 0;
			while (diffIndex < oldSorted.length && oldSorted[diffIndex].id === newSorted[diffIndex].id) {
				diffIndex++;
			}

			if (this.isAtHead) {
				let canUndo = true;
				const undoQueue: (() => void)[] = [];
				for (let i = oldSorted.length - 1; i >= diffIndex; i--) {
					const eventId = oldSorted[i].id;
					const undo = this.undoStack.get(eventId);
					if (undo) {
						undoQueue.push(undo);
					} else {
						canUndo = false;
						break;
					}
				}

				if (canUndo) {
					// Undo phase
					for (const undo of undoQueue) {
						undo();
					}
					for (let i = diffIndex; i < oldSorted.length; i++) {
						this.undoStack.delete(oldSorted[i].id);
					}

					// Redo phase
					for (let i = diffIndex; i < newSorted.length; i++) {
						const undo = this.applyNewEvent(newSorted[i]);
						this.undoStack.set(newSorted[i].id, undo);
					}
				} else {
					// Fallback to full rebuild
					this.doc._setRoot(new YMap(this.doc, []));
					this.undoStack.clear();
					for (const ev of newSorted) {
						const undo = this.applyNewEvent(ev);
						this.undoStack.set(ev.id, undo);
					}
				}
			} else {
				// Fallback to full rebuild
				this.doc._setRoot(new YMap(this.doc, []));
				this.undoStack.clear();
				for (const ev of newSorted) {
					const undo = this.applyNewEvent(ev);
					this.undoStack.set(ev.id, undo);
				}
			}
			this.cachedSortedEvents = newSorted;
			this.isAtHead = true;
		}

		return addedEvents;
	}


	/**
	 * Applies the operation from a single event to the document's state.
	 * It traverses the path in the operation and applies the change to the target CRDT.
	 * @param event The event to apply.
	 * @returns An undo closure that reverses the applied operation.
	 */
	private applyNewEvent(event: CrdtEvent): () => void {
		const { op } = event;
		const undoActions: (() => void)[] = [];

		if (op.type === SNAPSHOT_OP) {
			const oldRoot = this.doc.getMap();
			const newRoot = YMap.fromSnapshot(this.doc, [], op.state);
			this.doc._setRoot(newRoot);
			return () => {
				this.doc._setRoot(oldRoot);
			};
		}

		let current: YMap | YArray | YText = this.doc.getMap();

		// Traverse the path, creating intermediate objects if they don't exist.
		for (let i = 0; i < op.path.length; i++) {
			const key = op.path[i];
			let next: YMap | YArray | YText | undefined;

			if (current instanceof YMap) {
				const strKey = String(key);
				const wrapper = current._getWrapper(strKey);
				const val: unknown = wrapper?.value;

				if (val instanceof YMap || val instanceof YArray || val instanceof YText) {
					next = val;
					// Converge the container's LWW id to the smallest id of any op that
					// traverses it. A container created locally by getMap/getArray/getText
					// carries no id (undefined), while on a remote replica the same
					// container is materialized lazily by the first op to reach it and so
					// carries that op's id. Since events are applied in ascending id order,
					// stamping the minimum id here makes the container's id replica-
					// independent, so a concurrent primitive set resolves LWW the same way
					// on every replica instead of depending on local call ordering.
					const undoStamp = current._stampEventId(strKey, event.id);
					undoActions.push(undoStamp);
				} else if (val !== undefined) {
					// It's a primitive. Do LWW comparison.
					const existingEventId = wrapper?.eventId;
					if (!existingEventId || compareEventIds(event.id, existingEventId) >= 0) {
						// Overwrite primitive with appropriate container
						const newPath = op.path.slice(0, i + 1);
						if (i === op.path.length - 1) {
							if (op.type === ARRAY_INSERT_OP || op.type === ARRAY_DELETE_OP) {
								next = new YArray(this.doc, newPath);
							} else if (op.type === TEXT_INSERT_OP || op.type === TEXT_FORMAT_OP || op.type === TEXT_DELETE_OP) {
								next = new YText(this.doc, newPath);
							} else {
								next = new YMap(this.doc, newPath);
							}
						} else {
							next = new YMap(this.doc, newPath);
						}
						const undoSet = current._applySet(strKey, next, event.id);
						if (undoSet) undoActions.push(undoSet);

						// If the container failed to attach due to LWW conflict, halt traversal gracefully
						if (current._getWrapper(strKey)?.eventId !== event.id) {
							return () => {
								for (let j = undoActions.length - 1; j >= 0; j--) {
									undoActions[j]();
								}
							};
						}
					} else {
						// Existing primitive wins, graceful no-op for the rest of this event
						return () => {
							for (let j = undoActions.length - 1; j >= 0; j--) {
								undoActions[j]();
							}
						};
					}
				} else {
					// Undefined, create container
					const newPath = op.path.slice(0, i + 1);
					if (i === op.path.length - 1) {
						if (
							op.type === ARRAY_INSERT_OP ||
							op.type === ARRAY_DELETE_OP
						) {
							next = new YArray(this.doc, newPath);
						} else if (
							op.type === TEXT_INSERT_OP ||
							op.type === TEXT_FORMAT_OP ||
							op.type === TEXT_DELETE_OP
						) {
							next = new YText(this.doc, newPath);
						} else {
							// Default to creating a YMap if it's a map operation.
							next = new YMap(this.doc, newPath);
						}
					} else {
						// For intermediate paths, always create a YMap.
						next = new YMap(this.doc, newPath);
					}
					const undoSet = current._applySet(strKey, next, event.id);
					if (undoSet) undoActions.push(undoSet);

					// If the container failed to attach due to LWW conflict, halt traversal gracefully
					if (current._getWrapper(strKey)?.eventId !== event.id) {
						return () => {
							for (let j = undoActions.length - 1; j >= 0; j--) {
								undoActions[j]();
							}
						};
					}
				}
			} else if (current instanceof YArray) {
				const numKey = Number(key);
				const val: unknown = current.get(numKey);
				if (val instanceof YMap || val instanceof YArray || val instanceof YText) {
					next = val;
				} else {
					return () => {
						for (let j = undoActions.length - 1; j >= 0; j--) {
							undoActions[j]();
						}
					};
				}
			} else if (current instanceof YText) {
				return () => {
					for (let j = undoActions.length - 1; j >= 0; j--) {
						undoActions[j]();
					}
				};
			} else {
				return () => {
					for (let j = undoActions.length - 1; j >= 0; j--) {
						undoActions[j]();
					}
				};
			}
			current = next;
		}

		const target = current;

		switch (op.type) {
			case MAP_SET_OP:
				if (target instanceof YMap) {
					undoActions.push(target._applySet(op.key, op.value, event.id));
				}
				break;
			case MAP_DELETE_OP:
				if (target instanceof YMap) {
					undoActions.push(target._applyDelete(op.key, event.id));
				}
				break;
			case ARRAY_INSERT_OP:
				if (target instanceof YArray) {
					undoActions.push(target._applyInsert(event.id, op.afterId, op.values));
				}
				break;
			case ARRAY_DELETE_OP:
				if (target instanceof YArray) {
					undoActions.push(target._applyDelete(op.targetIds));
				}
				break;

			case TEXT_INSERT_OP:
				if (target instanceof YText) {
					undoActions.push(target._applyInsert(event.id, op.afterId, op.text));
				}
				break;
			case TEXT_FORMAT_OP:
				if (target instanceof YText) {
					undoActions.push(target._applyFormat(op.targetIds, op.attributes));
				}
				break;
			case TEXT_DELETE_OP:
				if (target instanceof YText) {
					undoActions.push(target._applyDelete(op.targetIds));
				}
				break;
		}

		return () => {
			for (let i = undoActions.length - 1; i >= 0; i--) {
				undoActions[i]();
			}
		};
	}

	/**
	 * Integrates a list of remote events into the document.
	 *
	 * Integration is tolerant of missing parents and out-of-order delivery: an
	 * event whose parents are not yet present is buffered and integrated later
	 * once they arrive. It never throws for a missing parent.
	 * @param events The array of events to integrate.
	 * @returns The events that were actually integrated into the graph by this
	 *   call, in causal order. This includes any previously-buffered events that
	 *   the incoming events unblocked, and excludes duplicates and still-orphaned
	 *   events. Callers persisting integrated events should persist exactly this
	 *   list so that a saved event is always replayable.
	 */
	integrateRemote(events: CrdtEvent[]): CrdtEvent[] {
		const added = this._ingestEvents(events);
		for (const event of added) {
			this.notifyListeners(event, event.replicaId === this.replicaId);
		}
		return added;
	}

	/**
	 * Returns the number of events currently buffered awaiting their parents.
	 * Useful for observability and tests; a persistently non-zero value indicates
	 * events whose parents have not (yet) been delivered.
	 */
	getPendingEventCount(): number {
		return this.pendingEvents.size;
	}

	/**
	 * Creates a snapshot of the current state of the document and event graph.
	 * @returns A state snapshot object.
	 */
	getStateSnapshot(): StateSnapshot {
		const docSnap = this.doc.getSnapshot();
		return {
			doc: docSnap,
			graph: { events: this.graph.getEventEntries() },
			replicaId: this.replicaId,
			sequenceNumber: this.sequenceNumber,
		};
	}

	/**
	 * Loads the document state from a previously created snapshot.
	 * This will overwrite the current document state and event graph.
	 * @param snapshot The state snapshot to load.
	 */
	loadStateSnapshot(snapshot: StateSnapshot) {
		this.graph = new EventGraph();
		this.pendingEvents.clear();
		snapshot.graph.events.forEach(([_, event]) => {
			this.graph.addEvent(event);
			// Advance the Lamport clock on observation of every event, regardless of
			// origin replica, so subsequent local ops causally follow the snapshot.
			this.observeSequenceNumber(event.id);
		});

		if (snapshot.replicaId === this.replicaId) {
			this.sequenceNumber = Math.max(
				this.sequenceNumber,
				snapshot.sequenceNumber,
			);
		}

		const newRoot = YMap.fromSnapshot(this.doc, [], snapshot.doc);
		this.doc._setRoot(newRoot);
		this.undoStack.clear();
		this.cachedSortedEvents = this.graph.getSortedEvents();
		this.isAtHead = true;
	}

	/**
	 * Rebuilds the document state to match a specific version in the event graph's history.
	 * This is useful for viewing historical snapshots of the data.
	 * @param version An array of event IDs representing the target version.
	 */
	rebuildStateAtVersion(version: EventID[]) {
		const eventsToApply = this.graph.getEvents(version);
		const sortedEvents = this.graph.topologicalSort(eventsToApply);

		// Reset the document state
		this.doc._setRoot(new YMap(this.doc, []));
		this.undoStack.clear();

		// Re-apply events in order
		for (const event of sortedEvents) {
			const undo = this.applyNewEvent(event);
			this.undoStack.set(event.id, undo);
		}

		if (this.graph.isCriticalVersion(version)) {
			this.cachedSortedEvents = sortedEvents;
			this.isAtHead = true;
		} else {
			this.isAtHead = false;
		}
	}

	/**
	 * Sets the awareness state for the current replica.
	 * Awareness state is ephemeral and not stored in the event graph.
	 * @param state The awareness state to set.
	 */
	setAwareness(state: unknown) {
		this.awarenessStates.set(this.replicaId, state);
	}

	/**
	 * Gets the awareness state for a specific replica.
	 * @param replicaId The ID of the replica whose state to retrieve.
	 * @returns The awareness state, or undefined if not found.
	 */
	getAwareness(replicaId: string): unknown {
		return this.awarenessStates.get(replicaId);
	}
}
