/** The unique identifier for a replica. */
type ReplicaID = string;
/** A globally unique identifier for an event, typically in the format `<ReplicaID>:<number>`. */
export type EventID = string;

/** Constant for map set operations. */
export const MAP_SET_OP = 'map-set';
/** Constant for array insert operations. */
export const ARRAY_INSERT_OP = 'array-insert';
/** Constant for array delete operations. */
export const ARRAY_DELETE_OP = 'array-delete';
/** Constant for array replace operations. */
export const ARRAY_REPLACE_OP = 'array-replace';
/** Constant for text insert operations. */
export const TEXT_INSERT_OP = 'text-insert';
/** Constant for text format operations. */
export const TEXT_FORMAT_OP = 'text-format';

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

/** Represents an operation to insert elements into an array. */
export interface ArrayInsertOperation {
	type: typeof ARRAY_INSERT_OP;
	/** The path to the target array within the document. */
	path: (string | number)[];
	/** The index at which to insert. */
	index: number;
	/** The values to insert. */
	values: unknown[];
}

/** Represents an operation to delete elements from an array. */
export interface ArrayDeleteOperation {
	type: typeof ARRAY_DELETE_OP;
	/** The path to the target array within the document. */
	path: (string | number)[];
	/** The index at which to start deleting. */
	index: number;
	/** The number of elements to delete. */
	length: number;
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
	/** The index at which to insert the text. */
	index: number;
	/** The text to insert. */
	text: string;
}

/** Represents an operation to apply formatting to a range of text in a YText object. */
export interface TextFormatOperation {
	type: typeof TEXT_FORMAT_OP;
	/** The path to the target text object within the document. */
	path: (string | number)[];
	/** The start index of the range to format. */
	index: number;
	/** The length of the range to format. */
	length: number;
	/** The formatting attributes to apply. */
	attributes: Record<string, unknown>;
}

/** A union of all possible operation types. */
export type Op =
	| MapSetOperation
	| ArrayInsertOperation
	| ArrayDeleteOperation
	| ArrayReplaceOperation
	| TextInsertOperation
	| TextFormatOperation;

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
		this.name = 'EventGraphError';
	}
}

/**
 * Type guard to check if an unknown value is a valid CrdtEvent.
 * @param event The value to check.
 * @returns True if the value is a CrdtEvent, false otherwise.
 */
export function isCrdtEvent(event: unknown): event is CrdtEvent {
	if (typeof event !== 'object' || event === null) {
		return false;
	}
	const e = event as Record<string, unknown>;
	if (typeof e.id !== 'string') return false;
	if (typeof e.replicaId !== 'string') return false;
	if (!Array.isArray(e.parents)) return false;
	if (!e.parents.every((p: unknown) => typeof p === 'string')) return false;
	if (typeof e.op !== 'object' || e.op === null) return false;
	const op = e.op as Record<string, unknown>;
	switch (op.type) {
		case MAP_SET_OP:
			if (typeof (op as unknown as MapSetOperation).key !== 'string')
				return false;
			break;
		case ARRAY_INSERT_OP:
			if (typeof (op as unknown as ArrayInsertOperation).index !== 'number')
				return false;
			if (!Array.isArray((op as unknown as ArrayInsertOperation).values))
				return false;
			break;
		case ARRAY_DELETE_OP:
			if (typeof (op as unknown as ArrayDeleteOperation).index !== 'number')
				return false;
			if (typeof (op as unknown as ArrayDeleteOperation).length !== 'number')
				return false;
			break;
		case ARRAY_REPLACE_OP:
			if (!Array.isArray((op as unknown as ArrayReplaceOperation).values))
				return false;
			break;
		case TEXT_INSERT_OP:
			if (typeof (op as unknown as TextInsertOperation).index !== 'number')
				return false;
			if (typeof (op as unknown as TextInsertOperation).text !== 'string')
				return false;
			break;
		case TEXT_FORMAT_OP:
			if (typeof (op as unknown as TextFormatOperation).index !== 'number')
				return false;
			if (typeof (op as unknown as TextFormatOperation).length !== 'number')
				return false;
			if (
				typeof (op as unknown as TextFormatOperation).attributes !== 'object'
			)
				return false;
			break;
		default:
			return false;
	}
	return true;
}

/**
 * Creates a new EventGraph instance.
 * The EventGraph is a data structure that stores the history of all operations as a DAG.
 * @param freezed Whether to freeze the internal `events` and `eventToCRDTMap` maps, making them read-only. Defaults to true.
 * @returns An object with methods to interact with the event graph.
 */
export function createEventGraph(freezed = true) {
	const events = new Map<EventID, CrdtEvent>();
	const eventToCRDTMap = new Map<EventID, EventID>();
	const children = new Map<EventID, Set<EventID>>();

	/**
	 * Adds a new event to the graph after validating it.
	 * @param event The event to add.
	 * @throws {EventGraphError} if the event is invalid (e.g., missing parents, circular dependency).
	 */
	function addEvent(event: CrdtEvent) {
		const op = event.op;
		switch (op.type) {
			case MAP_SET_OP:
				break;
			case ARRAY_INSERT_OP:
				if (op.index < 0) throw new EventGraphError('Invalid index');
				break;
			case ARRAY_DELETE_OP:
				if (op.index < 0 || op.length < 0)
					throw new EventGraphError('Invalid index or length');
				break;
			case ARRAY_REPLACE_OP:
				break;
			case TEXT_INSERT_OP:
				if (op.index < 0) throw new EventGraphError('Invalid index');
				break;
			case TEXT_FORMAT_OP:
				if (op.index < 0 || op.length < 0)
					throw new EventGraphError('Invalid index or length');
				break;
			default:
				throw new EventGraphError('Invalid operation type');
		}
		const hasMissingParent = event.parents.some((id) => !events.has(id));
		if (hasMissingParent) {
			throw new EventGraphError('Invalid parent');
		}
		// c8 ignore next 4
		const hasCircularDependency = event.parents.some((id) =>
			happenedBefore(event, events.get(id)!),
		);
		if (hasCircularDependency) {
			throw new EventGraphError('Invalid circular dependency');
		}
		events.set(event.id, event);
		for (const parentId of event.parents) {
			if (!children.has(parentId)) {
				children.set(parentId, new Set());
			}
			children.get(parentId)!.add(event.id);
		}
	}

	/**
	 * Retrieves an event from the graph by its ID.
	 * @param id The ID of the event to retrieve.
	 * @returns The event, or undefined if not found.
	 */
	function getEvent(id: EventID): CrdtEvent | undefined {
		return events.get(id);
	}

	/**
	 * Gets the current version of the graph, which is the set of "head" events (those with no children).
	 * @returns An array of event IDs representing the current version.
	 */
	function getVersion(): EventID[] {
		const allIds = new Set(events.keys());
		for (const event of events.values()) {
			for (const parentId of event.parents) {
				allIds.delete(parentId);
			}
		}
		return Array.from(allIds);
	}

	/**
	 * Retrieves all events that are ancestors of (and including) the events in the given version.
	 * @param version An array of event IDs representing the starting version.
	 * @returns An array of all reachable events from the given version.
	 */
	function getEvents(version: EventID[]): CrdtEvent[] {
		const reachable = new Set<EventID>(version);
		const stack = [...version];
		while (stack.length > 0) {
			const id = stack.pop()!;
			const event = getEvent(id);
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
			.map((id) => getEvent(id))
			.filter((e): e is CrdtEvent => e !== undefined);
	}

	/**
	 * Sorts a list of events topologically, ensuring that parent events come before their children.
	 * @param eventsToSort The array of events to sort.
	 * @returns A new array containing the sorted events.
	 */
	function topologicalSort(eventsToSort: CrdtEvent[]): CrdtEvent[] {
		const existingEvents = eventsToSort.filter((e) => events.has(e.id));
		const eventMap = new Map(existingEvents.map((e) => [e.id, e]));
		const visited = new Set<EventID>();
		const sorted: CrdtEvent[] = [];

		function visit(event: CrdtEvent) {
			if (visited.has(event.id)) {
				return;
			}
			visited.add(event.id);

			for (const parentId of event.parents) {
				const parentEvent = eventMap.get(parentId);
				if (parentEvent) {
					visit(parentEvent);
				}
			}
			sorted.push(event);
		}

		for (const event of existingEvents) {
			visit(event);
		}

		return sorted;
	}

	/**
	 * Checks if a given version is a "critical version" (i.e., it is the current version of the graph).
	 * @param version The version to check.
	 * @returns True if the version is the current version, false otherwise.
	 */
	function isCriticalVersion(version: EventID[]): boolean {
		const currentVersion = getVersion();
		if (currentVersion.length === 0) return false;
		if (currentVersion.join() !== version.join()) return false;
		return true;
	}

	/**
	 * Traverses back in history to find the last version that had only a single head.
	 * This can be useful for finding a common ancestor state.
	 * @returns The event IDs of the last single-headed version, or an empty array if not found.
	 */
	function getLastCriticalVersion(): EventID[] {
		let currentVersionIds = getVersion();

		while (currentVersionIds.length > 0) {
			const parentIds = new Set<EventID>();
			for (const eventId of currentVersionIds) {
				const event = getEvent(eventId);
				if (event) {
					for (const parentId of event.parents) {
						parentIds.add(parentId);
					}
				}
			}

			if (parentIds.size === 1) {
				return Array.from(parentIds);
			}

			if (parentIds.size === 0) {
				return [];
			}

			currentVersionIds = Array.from(parentIds);
		}

		return [];
	}

	/**
	 * Gets all events in the current graph that are not ancestors of the given version.
	 * This is useful for finding out what has changed since a particular point in time.
	 * @param version The version to compare against.
	 * @returns An array of events that have occurred since the given version.
	 */
	function getChangesSince(version: EventID[]): CrdtEvent[] {
		const knownEvents = getEvents(version);
		const knownEventIds = new Set(knownEvents.map((e) => e.id));

		const allEvents = Array.from(events.values());
		const changes = allEvents.filter((event) => !knownEventIds.has(event.id));

		return changes;
	}

	/**
	 * Checks if event `a` happened before event `b` (i.e., `a` is an ancestor of `b`).
	 * @param a The first event.
	 * @param b The second event.
	 * @returns True if `a` is an ancestor of `b`, false otherwise.
	 */
	function happenedBefore(a: CrdtEvent, b: CrdtEvent): boolean {
		if (a.id === b.id) return true;
		const stack = [a.id];
		const visited = new Set<EventID>();

		while (stack.length > 0) {
			const currentId = stack.pop()!;
			if (visited.has(currentId)) continue;
			visited.add(currentId);

			if (currentId === b.id) return true;

			const kids = children.get(currentId);
			if (kids) {
				for (const kidId of kids) {
					stack.push(kidId);
				}
			}
		}
		return false;
	}

	return {
		addEvent,
		getEvent,
		getVersion,
		getEvents,
		getChangesSince,
		topologicalSort,
		isCriticalVersion,
		getLastCriticalVersion,
		happenedBefore,
		...(freezed
			? {
					get events() {
						return Object.freeze(events);
					},
					get eventToCRDTMap() {
						return Object.freeze(eventToCRDTMap);
					},
			  }
			: {
					events,
					eventToCRDTMap,
			  }),
	};
}