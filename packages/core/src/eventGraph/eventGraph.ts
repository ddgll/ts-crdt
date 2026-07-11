/** The unique identifier for a replica. */
type ReplicaID = string;
/** A globally unique identifier for an event, typically in the format `<ReplicaID>:<number>`. */
export type EventID = string;

/** Constant for map set operations. */
export const MAP_SET_OP = "map-set";
/** Constant for map delete operations. */
export const MAP_DELETE_OP = "map-delete";
/** Constant for array insert operations. */
export const ARRAY_INSERT_OP = "array-insert";
/** Constant for array delete operations. */
export const ARRAY_DELETE_OP = "array-delete";
/** Constant for array replace operations. */
export const ARRAY_REPLACE_OP = "array-replace";
/** Constant for text insert operations. */
export const TEXT_INSERT_OP = "text-insert";
/** Constant for text format operations. */
export const TEXT_FORMAT_OP = "text-format";
/** Constant for text delete operations. */
export const TEXT_DELETE_OP = "text-delete";
/** Constant for snapshot operations. */
export const SNAPSHOT_OP = "snapshot";

/** Represents an operation to set a key-value pair in a map. */
export interface MapSetOperation {
	type: typeof MAP_SET_OP;
	/** The path to the target map within the document. */
	path: (string | number)[];
	/** The key to set. */
	key: string;
	/** The value to set. */
	value: unknown;
}

/** Represents an operation to delete a key from a map. */
export interface MapDeleteOperation {
	type: typeof MAP_DELETE_OP;
	/** The path to the target map within the document. */
	path: (string | number)[];
	/** The key to delete. */
	key: string;
}

/** Represents an operation to insert elements into an array. */
export interface ArrayInsertOperation {
	type: typeof ARRAY_INSERT_OP;
	/** The path to the target array within the document. */
	path: (string | number)[];
	/** The ID of the element to insert after. Null indicates insertion at the beginning. */
	afterId: string | null;
	/** The values to insert. */
	values: unknown[];
}

/** Represents an operation to delete elements from an array. */
export interface ArrayDeleteOperation {
	type: typeof ARRAY_DELETE_OP;
	/** The path to the target array within the document. */
	path: (string | number)[];
	/** The IDs of the elements to delete. */
	targetIds: string[];
}

/** Represents an operation to replace the entire contents of an array. */
export interface ArrayReplaceOperation {
	type: typeof ARRAY_REPLACE_OP;
	/** The path to the target array within the document. */
	path: (string | number)[];
	/** The new values for the array. */
	values: unknown[];
}

/** Represents an operation to insert text into a YText object. */
export interface TextInsertOperation {
	type: typeof TEXT_INSERT_OP;
	/** The path to the target text object within the document. */
	path: (string | number)[];
	/** The ID of the character to insert after. Null indicates insertion at the beginning. */
	afterId: string | null;
	/** The text to insert. */
	text: string;
}

/** Represents an operation to apply formatting to a range of text in a YText object. */
export interface TextFormatOperation {
	type: typeof TEXT_FORMAT_OP;
	/** The path to the target text object within the document. */
	path: (string | number)[];
	/** The IDs of the characters to format. */
	targetIds: string[];
	/** The formatting attributes to apply. */
	attributes: Record<string, unknown>;
}

/** Represents an operation to delete text from a YText object. */
export interface TextDeleteOperation {
	type: typeof TEXT_DELETE_OP;
	/** The path to the target text object within the document. */
	path: (string | number)[];
	/** The IDs of the characters to delete. */
	targetIds: string[];
}

/** Represents an operation to load a full document snapshot. */
export interface SnapshotOperation {
	type: typeof SNAPSHOT_OP;
	/** The serialized document state. */
	state: Record<string, unknown>;
}

/** A union of all possible operation types. */
export type Op =
	| MapSetOperation
	| MapDeleteOperation
	| ArrayInsertOperation
	| ArrayDeleteOperation
	| ArrayReplaceOperation
	| TextInsertOperation
	| TextFormatOperation
	| TextDeleteOperation
	| SnapshotOperation;

/**
 * Represents a single event in the CRDT's history.
 * Each event is a node in a directed acyclic graph (DAG).
 */
export interface CrdtEvent {
	/** The unique ID of the event. */
	id: EventID;
	/** The ID of the replica that created the event. */
	replicaId: ReplicaID;
	/** The IDs of the events that immediately precede this one in the graph. */
	parents: EventID[];
	/** The actual operation performed in this event. */
	op: Op;
}

/** Custom error class for errors originating from the EventGraph. */
export class EventGraphError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EventGraphError";
	}
}

function isValidPath(path: unknown): path is (string | number)[] {
	if (!Array.isArray(path)) return false;
	return path.every(segment =>
		typeof segment === "string" || typeof segment === "number"
	);
}

/**
 * Type guard to check if an unknown value is a valid CrdtEvent.
 * @param event The value to check.
 * @returns True if the value is a CrdtEvent, false otherwise.
 */
export function isCrdtEvent(event: unknown): event is CrdtEvent {
	if (typeof event !== "object" || event === null) {
		return false;
	}
	const e = event as Record<string, unknown>;
	if (typeof e.id !== "string") return false;
	if (typeof e.replicaId !== "string") return false;
	if (!Array.isArray(e.parents)) return false;
	if (!e.parents.every((p: unknown) => typeof p === "string")) return false;
	if (typeof e.op !== "object" || e.op === null) return false;
	const op = e.op as Record<string, unknown>;
	switch (op.type) {
		case MAP_SET_OP:
			if (!isValidPath((op as unknown as MapSetOperation).path)) return false;
			if (typeof (op as unknown as MapSetOperation).key !== "string") {
				return false;
			}
			if ((op as unknown as MapSetOperation).key === "__proto__") return false;
			if ((op as unknown as MapSetOperation).key === "constructor") return false;
			break;
		case MAP_DELETE_OP:
			if (!isValidPath((op as unknown as MapDeleteOperation).path)) return false;
			if (typeof (op as unknown as MapDeleteOperation).key !== "string") {
				return false;
			}
			if ((op as unknown as MapDeleteOperation).key === "__proto__") return false;
			if ((op as unknown as MapDeleteOperation).key === "constructor") return false;
			break;
		case ARRAY_INSERT_OP:
			if (!isValidPath((op as unknown as ArrayInsertOperation).path)) return false;
			if (
				(op as unknown as ArrayInsertOperation).afterId !== null &&
				typeof (op as unknown as ArrayInsertOperation).afterId !== "string"
			) {
				return false;
			}
			if (
				!Array.isArray((op as unknown as ArrayInsertOperation).values)
			) {
				return false;
			}
			break;
		case ARRAY_DELETE_OP:
			if (!isValidPath((op as unknown as ArrayDeleteOperation).path)) return false;
			if (
				!Array.isArray((op as unknown as ArrayDeleteOperation).targetIds)
			) {
				return false;
			}
			break;
		case ARRAY_REPLACE_OP:
			if (!isValidPath((op as unknown as ArrayReplaceOperation).path)) return false;
			if (
				!Array.isArray((op as unknown as ArrayReplaceOperation).values)
			) {
				return false;
			}
			break;
		case TEXT_INSERT_OP:
			if (!isValidPath((op as unknown as TextInsertOperation).path)) return false;
			if (
				(op as unknown as TextInsertOperation).afterId !== null &&
				typeof (op as unknown as TextInsertOperation).afterId !== "string"
			) {
				return false;
			}
			if (
				typeof (op as unknown as TextInsertOperation).text !== "string"
			) {
				return false;
			}
			break;
		case TEXT_FORMAT_OP:
			if (!isValidPath((op as unknown as TextFormatOperation).path)) return false;
			if (
				!Array.isArray((op as unknown as TextFormatOperation).targetIds)
			) {
				return false;
			}
			if (
				typeof (op as unknown as TextFormatOperation).attributes !==
					"object" || (op as unknown as TextFormatOperation).attributes === null
			) {
				return false;
			}
			break;
		case TEXT_DELETE_OP:
			if (!isValidPath((op as unknown as TextDeleteOperation).path)) return false;
			if (
				!Array.isArray((op as unknown as TextDeleteOperation).targetIds)
			) {
				return false;
			}
			break;
		case SNAPSHOT_OP:
			if (
				typeof (op as unknown as SnapshotOperation).state !== "object" ||
				(op as unknown as SnapshotOperation).state === null
			) {
				return false;
			}
			break;
		default:
			return false;
	}
	return true;
}

/**
 * Compares two event IDs deterministically.
 * @param id1 The first event ID.
 * @param id2 The second event ID.
 * @returns A negative number if id1 < id2, a positive number if id1 > id2, or 0 if equal.
 */
export function compareEventIds(id1: string, id2: string): number {
	const [rep1, seq1Str] = id1.split(':');
	const [rep2, seq2Str] = id2.split(':');
	const seq1 = parseInt(seq1Str, 10);
	const seq2 = parseInt(seq2Str, 10);
	if (seq1 !== seq2) return seq1 - seq2;
	return rep1.localeCompare(rep2);
}

const VALID_OP_TYPES = new Set([
	MAP_SET_OP, MAP_DELETE_OP, ARRAY_INSERT_OP, ARRAY_DELETE_OP,
	ARRAY_REPLACE_OP, TEXT_INSERT_OP, TEXT_FORMAT_OP, TEXT_DELETE_OP,
	SNAPSHOT_OP,
]);

/**
 * The EventGraph is a data structure that stores the history of all operations as a DAG.
 */
export class EventGraph {
	private events = new Map<EventID, CrdtEvent>();
	private children = new Map<EventID, Set<EventID>>();
	private heads = new Set<EventID>();
	private sortedEvents: CrdtEvent[] = [];
	private lastCriticalVersionCache: EventID[] | null = null;

	/**
	 * Adds a new event to the graph after validating it.
	 * @param event The event to add.
	 * @throws {EventGraphError} if the event is invalid (e.g., missing parents, circular dependency).
	 */
	addEvent(event: CrdtEvent): void {
		const op = event.op;
		if (!VALID_OP_TYPES.has(op.type)) {
			throw new EventGraphError("Invalid operation type");
		}
		if (this.events.has(event.id)) {
			return;
		}
		const hasMissingParent = event.parents.some((id) => !this.events.has(id));
		if (hasMissingParent) {
			throw new EventGraphError("Invalid parent");
		}
		if (event.parents.includes(event.id)) {
			throw new EventGraphError("Event cannot be its own parent");
		}
		this.events.set(event.id, event);
		this.heads.add(event.id);
		for (const parentId of event.parents) {
			this.heads.delete(parentId);
			if (!this.children.has(parentId)) {
				this.children.set(parentId, new Set());
			}
			this.children.get(parentId)!.add(event.id);
		}

		// Incremental sort: try fast append
		if (this.canAppend(event)) {
			this.sortedEvents.push(event);
		} else {
			// Full re-sort needed — cache invalidation
			this.sortedEvents = this.topologicalSort(this.getAllEvents());
		}

		// Invalidate cache if the graph now has multiple heads
		if (this.heads.size > 1) {
			this.lastCriticalVersionCache = null;
		} else if (this.heads.size === 1) {
			this.lastCriticalVersionCache = [Array.from(this.heads)[0]];
		}
	}

	private canAppend(event: CrdtEvent): boolean {
		if (this.sortedEvents.length === 0) return true;
		const lastId = this.sortedEvents[this.sortedEvents.length - 1].id;
		return compareEventIds(event.id, lastId) > 0;
	}

	/**
	 * Gets the incrementally maintained sorted events list.
	 */
	getSortedEvents(): CrdtEvent[] {
		return this.sortedEvents;
	}

	/**
	 * Retrieves an event from the graph by its ID.
	 * @param id The ID of the event to retrieve.
	 * @returns The event, or undefined if not found.
	 */
	getEvent(id: EventID): CrdtEvent | undefined {
		return this.events.get(id);
	}

	/**
	 * Gets the current version of the graph, which is the set of "head" events (those with no children).
	 * @returns An array of event IDs representing the current version.
	 */
	getVersion(): EventID[] {
		return Array.from(this.heads);
	}

	/**
	 * Retrieves all events that are ancestors of (and including) the events in the given version.
	 * @param version An array of event IDs representing the starting version.
	 * @returns An array of all reachable events from the given version.
	 */
	getEvents(version: EventID[]): CrdtEvent[] {
		const reachable = new Set<EventID>(version);
		const stack = [...version];
		while (stack.length > 0) {
			const id = stack.pop()!;
			const event = this.getEvent(id);
			if (event) {
				for (const parentId of event.parents) {
					if (!reachable.has(parentId)) {
						reachable.add(parentId);
						stack.push(parentId);
					}
				}
			}
		}
		return Array.from(reachable)
			.map((id) => this.getEvent(id))
			.filter((e): e is CrdtEvent => e !== undefined);
	}

	/**
	 * Sorts a list of events topologically, ensuring that parent events come before their children.
	 * @param eventsToSort The array of events to sort.
	 * @returns A new array containing the sorted events.
	 */
	topologicalSort(eventsToSort: CrdtEvent[]): CrdtEvent[] {
		const existingEvents = eventsToSort.filter((e) => this.events.has(e.id));
		const eventMap = new Map(existingEvents.map((e) => [e.id, e]));
		const visited = new Set<EventID>();
		const inStack = new Set<EventID>();
		const sorted: CrdtEvent[] = [];

		// Sort events by ID for deterministic iteration — ensures concurrent
		// events are always applied in the same order across all replicas.
		const sortedExisting = [...existingEvents].sort((a, b) => compareEventIds(a.id, b.id));

		for (const rootEvent of sortedExisting) {
			if (visited.has(rootEvent.id)) continue;

			const stack: { event: CrdtEvent; parents: EventID[]; parentIndex: number }[] = [];
			stack.push({
				event: rootEvent,
				parents: [...rootEvent.parents].sort(compareEventIds),
				parentIndex: 0
			});
			inStack.add(rootEvent.id);

			while (stack.length > 0) {
				const current = stack[stack.length - 1];

				if (current.parentIndex < current.parents.length) {
					const parentId = current.parents[current.parentIndex];
					current.parentIndex++;

					const parentEvent = eventMap.get(parentId);
					if (parentEvent && !visited.has(parentEvent.id) && !inStack.has(parentEvent.id)) {
						stack.push({
							event: parentEvent,
							parents: [...parentEvent.parents].sort(compareEventIds),
							parentIndex: 0
						});
						inStack.add(parentEvent.id);
					}
				} else {
					const finished = stack.pop()!;
					inStack.delete(finished.event.id);
					visited.add(finished.event.id);
					sorted.push(finished.event);
				}
			}
		}

		return sorted;
	}

	/**
	 * Checks if a given version is a "critical version" (i.e., it is the current version of the graph).
	 * @param version The version to check.
	 * @returns True if the version is the current version, false otherwise.
	 */
	isCriticalVersion(version: EventID[]): boolean {
		const currentVersion = this.getVersion();
		if (currentVersion.length === 0) return false;
		if (currentVersion.length !== version.length) return false;
		const sortedCurrent = [...currentVersion].sort();
		const sortedVersion = [...version].sort();
		return sortedCurrent.every((id, i) => id === sortedVersion[i]);
	}

	/**
	 * Traverses back in history to find the last version that had only a single head.
	 * This can be useful for finding a common ancestor state.
	 * @returns The event IDs of the last single-headed version, or an empty array if not found.
	 */
	getLastCriticalVersion(): EventID[] {
		if (this.lastCriticalVersionCache !== null) {
			return this.lastCriticalVersionCache;
		}
		const result = this._computeLastCriticalVersion();
		this.lastCriticalVersionCache = result;
		return result;
	}

	private _computeLastCriticalVersion(): EventID[] {
		const currentVersionIds = this.getVersion();
		if (currentVersionIds.length === 0) return [];
		if (currentVersionIds.length === 1) {
			return currentVersionIds;
		}

		const allEvents = this.topologicalSort(this.getAllEvents());
		const n = allEvents.length;
		const eventIndex = new Map<EventID, number>();
		allEvents.forEach((e, i) => eventIndex.set(e.id, i));

		let commonAncestors = new Set<EventID>();
		let first = true;
		for (const headId of currentVersionIds) {
			const ancestors = new Set<EventID>();
			const stack = [headId];
			ancestors.add(headId);
			while (stack.length > 0) {
				const curr = stack.pop()!;
				const ev = this.getEvent(curr);
				if (ev) {
					for (const p of ev.parents) {
						if (!ancestors.has(p)) {
							ancestors.add(p);
							stack.push(p);
						}
					}
				}
			}
			if (first) {
				commonAncestors = ancestors;
				first = false;
			} else {
				const intersection = new Set<EventID>();
				for (const a of commonAncestors) {
					if (ancestors.has(a)) intersection.add(a);
				}
				commonAncestors = intersection;
			}
		}

		const candidateIds = Array.from(commonAncestors).sort(
			(a, b) => eventIndex.get(b)! - eventIndex.get(a)!
		);

		for (const candidateId of candidateIds) {
			const i = eventIndex.get(candidateId)!;

			let ancestorCount = 0;
			const visitedA = new Set<EventID>();
			const stackA = [candidateId];
			visitedA.add(candidateId);
			while (stackA.length > 0) {
				const curr = stackA.pop()!;
				const ev = this.getEvent(curr);
				if (ev) {
					for (const p of ev.parents) {
						if (!visitedA.has(p)) {
							visitedA.add(p);
							stackA.push(p);
							ancestorCount++;
						}
					}
				}
			}

			if (ancestorCount !== i) continue;

			let descendantCount = 0;
			const visitedD = new Set<EventID>();
			const stackD = [candidateId];
			visitedD.add(candidateId);
			while (stackD.length > 0) {
				const curr = stackD.pop()!;
				const kids = this.children.get(curr);
				if (kids) {
					for (const k of kids) {
						if (!visitedD.has(k)) {
							visitedD.add(k);
							stackD.push(k);
							descendantCount++;
						}
					}
				}
			}

			if (descendantCount === n - 1 - i) {
				return [candidateId];
			}
		}

		return [];
	}

	/**
	 * Gets all events in the current graph that are not ancestors of the given version.
	 * This is useful for finding out what has changed since a particular point in time.
	 * @param version The version to compare against.
	 * @returns An array of events that have occurred since the given version.
	 */
	getChangesSince(version: EventID[]): CrdtEvent[] {
		if (version.length === 0) {
			return Array.from(this.events.values());
		}

		// Build set of all ancestors of the version (including the version itself)
		const ancestors = new Set<EventID>(version);
		const stack = [...version];
		while (stack.length > 0) {
			const id = stack.pop()!;
			const event = this.events.get(id);
			if (event) {
				for (const parentId of event.parents) {
					if (!ancestors.has(parentId)) {
						ancestors.add(parentId);
						stack.push(parentId);
					}
				}
			}
		}

		// Single pass: collect events not in the ancestor set
		const changes: CrdtEvent[] = [];
		for (const event of this.events.values()) {
			if (!ancestors.has(event.id)) {
				changes.push(event);
			}
		}
		return changes;
	}

	/**
	 * Checks if event `a` strictly happened before event `b` (i.e., `a` is a proper ancestor of `b`).
	 * Note: An event does NOT happen before itself (strict partial order).
	 * @param a The first event.
	 * @param b The second event.
	 * @returns True if `a` is a proper ancestor of `b`, false otherwise.
	 */
	happenedBefore(a: CrdtEvent, b: CrdtEvent): boolean {
		if (a.id === b.id) return false;
		const stack = [a.id];
		const visited = new Set<EventID>();

		while (stack.length > 0) {
			const currentId = stack.pop()!;
			if (visited.has(currentId)) continue;
			visited.add(currentId);

			if (currentId === b.id) return true;

			const kids = this.children.get(currentId);
			if (kids) {
				for (const kidId of kids) {
					stack.push(kidId);
				}
			}
		}
		return false;
	}

	/**
	 * Creates a compacted version of the graph, replacing history up to `version` with a single snapshot event.
	 * @param version The version to compact up to.
	 * @param snapshotState The serialized document state at `version`.
	 * @param snapshotReplicaId The replica ID to use for the new snapshot event.
	 * @param snapshotSequence The sequence number to use for the new snapshot event.
	 * @returns An object containing the new snapshot event and the rewritten remaining events.
	 */
	compact(
		version: EventID[],
		snapshotState: Record<string, unknown>,
		snapshotReplicaId: string,
		snapshotSequence: number
	): { snapshotEvent: CrdtEvent; remainingEvents: CrdtEvent[] } {
		const newSnapshotEvent: CrdtEvent = {
			id: `${snapshotReplicaId}:${snapshotSequence}`,
			replicaId: snapshotReplicaId,
			parents: [],
			op: {
				type: SNAPSHOT_OP,
				state: snapshotState,
			},
		};

		const eventsToKeep = this.getChangesSince(version);
		const newEvents: CrdtEvent[] = [];
		const keptIds = new Set(eventsToKeep.map((e) => e.id));

		for (const ev of eventsToKeep) {
			const newParents = ev.parents.map((p) =>
				keptIds.has(p) ? p : newSnapshotEvent.id
			);
			const uniqueParents = Array.from(new Set(newParents));

			newEvents.push({
				...ev,
				parents: uniqueParents,
			});
		}

		return { snapshotEvent: newSnapshotEvent, remainingEvents: newEvents };
	}

	/**
	 * Gets all events in the graph.
	 * @returns An array of all events.
	 */
	getAllEvents(): CrdtEvent[] {
		return Array.from(this.events.values());
	}

	/**
	 * Gets all events in the graph as entries [EventID, CrdtEvent].
	 * @returns An array of all event entries.
	 */
	getEventEntries(): [EventID, CrdtEvent][] {
		return Array.from(this.events.entries());
	}
}

/**
 * Creates a new EventGraph instance.
 * @deprecated Use `new EventGraph()` instead.
 * @returns An EventGraph instance.
 */
export function createEventGraph(): EventGraph {
	return new EventGraph();
}
