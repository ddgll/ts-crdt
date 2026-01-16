import {
	ARRAY_DELETE_OP,
	ARRAY_INSERT_OP,
	ARRAY_REPLACE_OP,
	CrdtEvent,
	createEventGraph,
	EventID,
	MAP_SET_OP,
	Op,
	TEXT_FORMAT_OP,
	TEXT_INSERT_OP,
} from '../eventGraph/eventGraph.js';
import { Doc } from '../crdtTypes/Doc.js';
import { YMap } from '../crdtTypes/YMap.js';
import { YArray } from '../crdtTypes/YArray.js';
import { YText } from '../crdtTypes/YText.js';

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
		this.name = 'EgWalkerError';
	}
}

/**
 * The EgWalker (Event Graph Walker) is the core engine for processing and applying CRDT events.
 * It manages the event graph, replica state, and document modifications.
 */
export class EgWalker {
	private doc: Doc;
	/** The underlying event graph instance. */
	public graph: ReturnType<typeof createEventGraph>;
	private replicaId: string;
	private sequenceNumber = 0;
	/** A map of awareness states for connected replicas. */
	public awarenessStates = new Map<string, unknown>();

	/**
	 * Creates a new EgWalker instance.
	 * @param doc The parent document.
	 * @param replicaId An optional unique identifier for this replica.
	 * @param graph An optional existing event graph to use.
	 */
	constructor(doc: Doc, replicaId?: string, graph = createEventGraph()) {
		this.graph = graph;
		this.doc = doc;
		this.replicaId = replicaId || Math.random().toString(36).substring(2, 15);
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
		this.graph.addEvent(event);
		this.applyNewEvent(event);
		return event;
	}

	/**
	 * Adds a remote or local event to the graph and applies it to the document.
	 * If the event already exists, it is ignored.
	 * @param event The event to add.
	 */
	addEvent(event: CrdtEvent) {
		if (this.graph.getEvent(event.id)) {
			return; // Event already exists, no need to re-apply
		}
		// If the incoming event is from the same replica, we need to update the sequence number
		// to ensure that the next generated event ID is unique.
		if (event.replicaId === this.replicaId) {
			const eventSequenceNumber = parseInt(event.id.split(':')[1], 10);
			if (eventSequenceNumber >= this.sequenceNumber) {
				this.sequenceNumber = eventSequenceNumber + 1;
			}
		}

		const currentHeads = new Set(this.graph.getVersion());
		const isDirectSuccessor =
			event.parents.length === currentHeads.size &&
			event.parents.every((p) => currentHeads.has(p));

		this.graph.addEvent(event);

		if (isDirectSuccessor) {
			this.applyNewEvent(event);
		} else {
			this.rebuildStateAtVersion(this.graph.getVersion());
		}
	}

	/**
	 * Applies the operation from a single event to the document's state.
	 * It traverses the path in the operation and applies the change to the target CRDT.
	 * @param event The event to apply.
	 */
	private applyNewEvent(event: CrdtEvent) {
		const { op } = event;
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
							op.type === ARRAY_DELETE_OP ||
							op.type === ARRAY_REPLACE_OP
						) {
							next = new YArray(this.doc, newPath);
						} else if (
							op.type === TEXT_INSERT_OP ||
							op.type === TEXT_FORMAT_OP
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
					current._set(key as string, next);
				}
			} else if (current instanceof YArray) {
				next = current.get(key as number) as YMap | YArray | YText | undefined;
				if (!next) {
					throw new EgWalkerError(`Could not find CRDT at path index: ${key}`);
				}
			} else if (current instanceof YText) {
				throw new EgWalkerError(
					`Path continues after YText at ${op.path.join('/')}`,
				);
			} else {
				throw new EgWalkerError(
					`Invalid path component in path: ${op.path.join('/')}`,
				);
			}
			current = next;
		}

		const target = current;

		switch (op.type) {
			case MAP_SET_OP:
				if (target instanceof YMap) {
					target._applySet(op.key, op.value);
				} else {
					throw new EgWalkerError('Target for map-set is not a YMap');
				}
				break;
			case ARRAY_INSERT_OP:
				if (target instanceof YArray) {
					target._applyInsert(op.index, op.values);
				} else {
					throw new EgWalkerError('Target for array-insert is not a YArray');
				}
				break;
			case ARRAY_DELETE_OP:
				if (target instanceof YArray) {
					target._applyDelete(op.index, op.length);
				} else {
					throw new EgWalkerError('Target for array-delete is not a YArray');
				}
				break;
			case ARRAY_REPLACE_OP:
				if (target instanceof YArray) {
					target._applyReplace(op.values);
				} else {
					throw new EgWalkerError(
						`Target for array-replace is not a YArray, but a ${
							target.constructor.name
						} at path ${op.path.join('/')}`,
					);
				}
				break;
			case TEXT_INSERT_OP:
				if (target instanceof YText) {
					target._applyInsert(op.index, op.text);
				} else {
					throw new EgWalkerError('Target for text-insert is not a YText');
				}
				break;
			case TEXT_FORMAT_OP:
				if (target instanceof YText) {
					// Formatting application is complex and not fully implemented here.
					// This is a placeholder for where that logic would go.
				} else {
					throw new EgWalkerError('Target for text-format is not a YText');
				}
				break;
		}
	}

	/**
	 * Integrates a list of remote events into the document.
	 * @param events The array of events to integrate.
	 */
	integrateRemote(events: CrdtEvent[]) {
		for (const event of events) {
			this.addEvent(event);
		}
	}

	/**
	 * Creates a snapshot of the current state of the document and event graph.
	 * @returns A state snapshot object.
	 */
	getStateSnapshot(): StateSnapshot {
		return {
			doc: this.doc.toJSON(),
			graph: { events: Array.from(this.graph.events.entries()) },
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
		// Do not overwrite this replica's ID.
		// this.replicaId = snapshot.replicaId;
		this.sequenceNumber = snapshot.sequenceNumber;

		this.graph = createEventGraph();
		snapshot.graph.events.forEach(([_, event]) => this.graph.addEvent(event));

		const newRoot = YMap.fromJSON(this.doc, [], snapshot.doc);
		this.doc._setRoot(newRoot);
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

		// Re-apply events in order
		for (const event of sortedEvents) {
			this.applyNewEvent(event);
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
