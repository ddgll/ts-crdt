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
} from "../eventGraph/eventGraph.js";
import { Doc } from "../crdtTypes/doc.js";
import { YMap } from "../crdtTypes/yMap.js";
import { YArray } from "../crdtTypes/yArray.js";
import { YText } from "../crdtTypes/yText.js";

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
 * The EgWalker (Event Graph Walker) is the core engine for processing and applying CRDT events.
 * It manages the event graph, replica state, and document modifications.
 */
export class EgWalker {
	private doc: Doc;
	/** The underlying event graph instance. */
	public graph: EventGraph;
	private replicaId: string;
	private sequenceNumber = 0;
	/** A map of awareness states for connected replicas. */
	public awarenessStates = new Map<string, unknown>();
	private eventListeners = new Set<(event: CrdtEvent, isLocal: boolean) => void>();
	private cachedSortedEvents: CrdtEvent[] = [];
	private undoStack = new Map<EventID, () => void>();
	private isAtHead = true;

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
				console.error("[EgWalker] Event listener error:", err);
			}
		}
	}

	/**
	 * Creates a new EgWalker instance.
	 * @param doc The parent document.
	 * @param replicaId An optional unique identifier for this replica.
	 * @param graph An optional existing event graph to use.
	 */
	constructor(doc: Doc, replicaId?: string, graph = new EventGraph()) {
		if (replicaId && replicaId.includes(':')) {
			throw new EgWalkerError("replicaId must not contain ':'");
		}
		this.graph = graph;
		this.doc = doc;
		this.replicaId = replicaId ||
			Math.random().toString(36).substring(2, 15);
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
	 * Generates the next unique sequence number for an event from this replica.
	 * @returns The next sequence number.
	 */
	private generateNextSequenceNumber(): number {
		return this.sequenceNumber++;
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

		for (const event of events) {
			if (this.graph.getEvent(event.id)) {
				continue;
			}
			if (event.replicaId === this.replicaId) {
				const eventSequenceNumber = parseInt(event.id.split(":")[1], 10);
				if (eventSequenceNumber >= this.sequenceNumber) {
					this.sequenceNumber = eventSequenceNumber + 1;
				}
			}

			this.graph.addEvent(event);
			addedEvents.push(event);
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
				next = current.get(key as string) as
					| YMap
					| YArray
					| YText
					| undefined;
				if (!next) {
					const newPath = op.path.slice(0, i + 1);
					// If we are at the last segment of the path, create the correct leaf type.
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
					const undoSet = current._applySet(key as string, next);
					if (undoSet) undoActions.push(undoSet);
				}
			} else if (current instanceof YArray) {
				next = current.get(key as number) as
					| YMap
					| YArray
					| YText
					| undefined;
				if (!next) {
					throw new EgWalkerError(
						`Could not find CRDT at path index: ${key}`,
					);
				}
			} else if (current instanceof YText) {
				throw new EgWalkerError(
					`Path continues after YText at ${op.path.join("/")}`,
				);
			} else {
				throw new EgWalkerError(
					`Invalid path component in path: ${op.path.join("/")}`,
				);
			}
			current = next;
		}

		const target = current;

		switch (op.type) {
			case MAP_SET_OP:
				if (target instanceof YMap) {
					undoActions.push(target._applySet(op.key, op.value, event.id));
				} else {
					throw new EgWalkerError("Target for map-set is not a YMap");
				}
				break;
			case MAP_DELETE_OP:
				if (target instanceof YMap) {
					undoActions.push(target._applyDelete(op.key));
				} else {
					throw new EgWalkerError("Target for map-delete is not a YMap");
				}
				break;
			case ARRAY_INSERT_OP:
				if (target instanceof YArray) {
					undoActions.push(target._applyInsert(event.id, op.afterId, op.values));
				} else {
					throw new EgWalkerError(
						"Target for array-insert is not a YArray",
					);
				}
				break;
			case ARRAY_DELETE_OP:
				if (target instanceof YArray) {
					undoActions.push(target._applyDelete(op.targetIds));
				} else {
					throw new EgWalkerError(
						"Target for array-delete is not a YArray",
					);
				}
				break;

			case TEXT_INSERT_OP:
				if (target instanceof YText) {
					undoActions.push(target._applyInsert(event.id, op.afterId, op.text));
				} else {
					throw new EgWalkerError(
						"Target for text-insert is not a YText",
					);
				}
				break;
			case TEXT_FORMAT_OP:
				if (target instanceof YText) {
					undoActions.push(target._applyFormat(op.targetIds, op.attributes));
				} else {
					throw new EgWalkerError(
						"Target for text-format is not a YText",
					);
				}
				break;
			case TEXT_DELETE_OP:
				if (target instanceof YText) {
					undoActions.push(target._applyDelete(op.targetIds));
				} else {
					throw new EgWalkerError(
						"Target for text-delete is not a YText",
					);
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
	 * @param events The array of events to integrate.
	 */
	integrateRemote(events: CrdtEvent[]) {
		const added = this._ingestEvents(events);
		for (const event of added) {
			this.notifyListeners(event, event.replicaId === this.replicaId);
		}
	}

	/**
	 * Creates a snapshot of the current state of the document and event graph.
	 * @returns A state snapshot object.
	 */
	getStateSnapshot(): StateSnapshot {
		return {
			doc: this.doc.getSnapshot() as Record<string, unknown>,
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
		snapshot.graph.events.forEach(([_, event]) => {
			this.graph.addEvent(event);
			if (event.replicaId === this.replicaId) {
				const eventSequenceNumber = parseInt(event.id.split(":")[1], 10);
				if (eventSequenceNumber >= this.sequenceNumber) {
					this.sequenceNumber = eventSequenceNumber + 1;
				}
			}
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
