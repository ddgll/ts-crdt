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
	/** The ID of the element to insert after (left origin). Null indicates insertion at the beginning. */
	afterId: string | null;
	/**
	 * The ID of the element to insert before (right origin). Null indicates
	 * insertion at the end. Optional for backwards compatibility: events created
	 * before right-origin support carry no `beforeId` and are integrated as if it
	 * were null (open-ended to the right).
	 */
	beforeId?: string | null;
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


export interface TextInsertOperation {
	type: typeof TEXT_INSERT_OP;
	/** The path to the target text object within the document. */
	path: (string | number)[];
	/** The ID of the character to insert after (left origin). Null indicates insertion at the beginning. */
	afterId: string | null;
	/**
	 * The ID of the character to insert before (right origin). Null indicates
	 * insertion at the end. Optional for backwards compatibility: events created
	 * before right-origin support carry no `beforeId` and are integrated as if it
	 * were null (open-ended to the right).
	 */
	beforeId?: string | null;
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
	/**
	 * State-vector of the history folded into this snapshot: for each replica id,
	 * the highest Lamport sequence number among the folded events (including any
	 * previously-folded snapshot's vector, so it accumulates across successive
	 * compactions). Lets a client receiving this snapshot distinguish an event
	 * that is *already reflected* in the snapshot state (covered by the vector —
	 * must NOT be re-applied, or content duplicates) from one the server has
	 * genuinely never seen (not covered — safe to re-integrate). Optional for
	 * backwards compatibility with snapshots created before this field existed.
	 */
	folded?: Record<string, number>;
}

export type Op =
	| MapSetOperation
	| MapDeleteOperation
	| ArrayInsertOperation
	| ArrayDeleteOperation
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

/**
 * Object keys that can trigger prototype pollution if written into a plain
 * object literal. These are rejected as map keys and path segments at the
 * validation boundary.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Checks whether a string is a key that could pollute an object's prototype.
 * @param key The candidate key or path segment.
 * @returns True if the key is unsafe to use as an object key.
 */
function isDangerousKey(key: string): boolean {
	return DANGEROUS_KEYS.has(key);
}

function isValidPath(path: unknown): path is (string | number)[] {
	if (!Array.isArray(path)) return false;
	return path.every(segment => {
		if (typeof segment === "string") return !isDangerousKey(segment);
		return typeof segment === "number";
	});
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
	return typeof obj === "object" && obj !== null;
}

/**
 * Upper bound on the Lamport sequence number embedded in an event id. Bounding
 * it at validation time stops a crafted/corrupt event from poisoning a replica's
 * clock past the safe-integer range: once `sequenceNumber` saturates near
 * `Number.MAX_SAFE_INTEGER`, `sequenceNumber++` stops advancing and the replica
 * mints colliding ids, silently dropping its own subsequent events. The margin
 * leaves head-room for many further local operations.
 */
export const MAX_EVENT_SEQUENCE = Number.MAX_SAFE_INTEGER - 2 ** 20;

/**
 * Validates an event id of the form `replicaId:sequence`, additionally bounding
 * the sequence number to {@link MAX_EVENT_SEQUENCE}.
 */
function isValidEventId(id: unknown): id is string {
	if (typeof id !== "string") return false;
	const match = /^[^:]+:(\d+)$/.exec(id);
	if (!match) return false;
	const seqStr = match[1];
	// Reject absurdly long sequences cheaply before the numeric bound check.
	if (seqStr.length > 16) return false;
	const seq = Number(seqStr);
	return Number.isSafeInteger(seq) && seq <= MAX_EVENT_SEQUENCE;
}

/**
 * Type guard to check if an unknown value is a valid CrdtEvent.
 * @param event The value to check.
 * @returns True if the value is a CrdtEvent, false otherwise.
 */
export function isCrdtEvent(event: unknown): event is CrdtEvent {
	if (!isRecord(event)) {
		return false;
	}
	const e = event;
	if (!isValidEventId(e.id)) return false;
	if (typeof e.replicaId !== "string") return false;
	if (!Array.isArray(e.parents)) return false;
	if (!e.parents.every((p: unknown) => isValidEventId(p))) return false;
	if (!isRecord(e.op)) return false;
	const op = e.op;
	switch (op.type) {
		case MAP_SET_OP:
			if (!isValidPath(op.path)) return false;
			if (typeof op.key !== "string") return false;
			if (isDangerousKey(op.key)) return false;
			break;
		case MAP_DELETE_OP:
			if (!isValidPath(op.path)) return false;
			if (typeof op.key !== "string") return false;
			if (isDangerousKey(op.key)) return false;
			break;
		case ARRAY_INSERT_OP:
			if (!isValidPath(op.path)) return false;
			if (op.afterId !== null && typeof op.afterId !== "string") return false;
			// `beforeId` is optional (legacy events omit it); when present it must be null or a string.
			if (op.beforeId !== undefined && op.beforeId !== null && typeof op.beforeId !== "string") return false;
			if (!Array.isArray(op.values)) return false;
			break;
		case ARRAY_DELETE_OP:
			if (!isValidPath(op.path)) return false;
			if (!Array.isArray(op.targetIds)) return false;
			break;
		case TEXT_INSERT_OP:
			if (!isValidPath(op.path)) return false;
			if (op.afterId !== null && typeof op.afterId !== "string") return false;
			// `beforeId` is optional (legacy events omit it); when present it must be null or a string.
			if (op.beforeId !== undefined && op.beforeId !== null && typeof op.beforeId !== "string") return false;
			if (typeof op.text !== "string") return false;
			break;
		case TEXT_FORMAT_OP:
			if (!isValidPath(op.path)) return false;
			if (!Array.isArray(op.targetIds)) return false;
			if (!isRecord(op.attributes)) return false;
			break;
		case TEXT_DELETE_OP:
			if (!isValidPath(op.path)) return false;
			if (!Array.isArray(op.targetIds)) return false;
			break;
		case SNAPSHOT_OP:
			if (!isRecord(op.state)) return false;
			// `folded` is optional; when present it must map replica ids to numbers.
			if (op.folded !== undefined) {
				if (!isRecord(op.folded)) return false;
				for (const v of Object.values(op.folded)) {
					if (typeof v !== "number" || !Number.isFinite(v)) return false;
				}
			}
			break;
		default:
			return false;
	}
	return true;
}

/**
 * Compares two event IDs deterministically.
 *
 * The numeric part of an event id is a Lamport timestamp (see
 * `EgWalker.generateNextSequenceNumber`), so comparing it first gives a
 * causally-consistent total order: if event `a` happened-before event `b`,
 * then `b`'s timestamp is strictly greater, so `b` compares greater. The
 * `replicaId` tiebreak deterministically resolves concurrent events (equal
 * timestamps). This ordering is what makes last-writer-wins respect
 * happened-before.
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
	TEXT_INSERT_OP, TEXT_FORMAT_OP, TEXT_DELETE_OP,
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
	 *
	 * WARNING: this returns the graph's **internal** array by reference for
	 * performance (it is mutated in place by {@link addEvent}). Callers that need
	 * a stable snapshot across subsequent `addEvent` calls MUST copy it
	 * (`[...graph.getSortedEvents()]`); holding the reference and reading it later
	 * will observe in-place mutation. Use {@link getSortedEventsCopy} for a safe,
	 * owned copy.
	 */
	getSortedEvents(): CrdtEvent[] {
		return this.sortedEvents;
	}

	/**
	 * Returns a defensive shallow copy of the sorted events list that is safe to
	 * retain across future {@link addEvent} calls. Prefer this over
	 * {@link getSortedEvents} unless the borrowed-reference performance of the
	 * latter is specifically needed.
	 */
	getSortedEventsCopy(): CrdtEvent[] {
		return [...this.sortedEvents];
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

		// A critical version is a single event `c` that is a global articulation
		// point of the DAG: every event before `c` in causal order is an ancestor
		// of `c`, and every event after is a descendant. In a topological order
		// that is exactly: the prefix ending at `c` has `c` as its sole head
		// (`soleHead`) AND the suffix starting at `c` has `c` as its sole tail
		// (`soleTail`, i.e. sole head in the reversed graph).
		//
		// Both conditions are computed in two linear frontier passes instead of
		// the previous per-candidate ancestor/descendant BFS (which was O(n^2) —
		// see PLAN_05). The last critical version is the qualifying event with the
		// greatest topological index.
		const allEvents = this.topologicalSort(this.getAllEvents());
		const n = allEvents.length;
		if (n === 0) return [];

		// Forward pass: does the prefix [0..i] reduce to the single head allEvents[i]?
		const soleHead = new Array<boolean>(n);
		{
			const frontier = new Set<EventID>();
			for (let i = 0; i < n; i++) {
				const ev = allEvents[i];
				for (const p of ev.parents) {
					frontier.delete(p);
				}
				frontier.add(ev.id);
				soleHead[i] = frontier.size === 1;
			}
		}

		// Backward pass: does the suffix [i..n-1] reduce to the single tail
		// allEvents[i] when edges are followed child->parent?
		const soleTail = new Array<boolean>(n);
		{
			const frontier = new Set<EventID>();
			for (let i = n - 1; i >= 0; i--) {
				const ev = allEvents[i];
				const kids = this.children.get(ev.id);
				if (kids) {
					for (const k of kids) {
						frontier.delete(k);
					}
				}
				frontier.add(ev.id);
				soleTail[i] = frontier.size === 1;
			}
		}

		for (let i = n - 1; i >= 0; i--) {
			if (soleHead[i] && soleTail[i]) {
				return [allEvents[i].id];
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
		const eventsToKeep = this.getChangesSince(version);
		const keptIds = new Set(eventsToKeep.map((e) => e.id));

		// State-vector of the folded history: per replica, the highest Lamport seq
		// among the events being replaced by this snapshot. Prior snapshots folded
		// here contribute their own accumulated vectors, so coverage survives
		// successive compactions. Built as a Map and converted with
		// Object.fromEntries so a replica id like "__proto__" becomes an own data
		// property instead of touching the prototype.
		const foldedVector = new Map<string, number>();
		const observeFolded = (replicaId: string, seq: number) => {
			if (!Number.isFinite(seq)) return;
			const prev = foldedVector.get(replicaId);
			if (prev === undefined || prev < seq) foldedVector.set(replicaId, seq);
		};
		for (const ev of this.events.values()) {
			if (keptIds.has(ev.id)) continue;
			const [rid, seqStr] = ev.id.split(":");
			observeFolded(rid, parseInt(seqStr, 10));
			if (ev.op.type === SNAPSHOT_OP && ev.op.folded) {
				for (const [rid2, seq2] of Object.entries(ev.op.folded)) {
					if (typeof seq2 === "number") observeFolded(rid2, seq2);
				}
			}
		}

		const newSnapshotEvent: CrdtEvent = {
			id: `${snapshotReplicaId}:${snapshotSequence}`,
			replicaId: snapshotReplicaId,
			parents: [],
			op: {
				type: SNAPSHOT_OP,
				state: snapshotState,
				folded: Object.fromEntries(foldedVector),
			},
		};

		const newEvents: CrdtEvent[] = [];

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
