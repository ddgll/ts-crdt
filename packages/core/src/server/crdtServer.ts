import { CrdtEvent, Doc, ServerMessage, isCrdtEvent, generateReplicaId, SNAPSHOT_OP } from "../index.js";
import { Logger, getLogger } from "../logger.js";
import { PubSubAdapter } from "./pubSubAdapter.js";

/**
 * Interface representing a repository to persist and load CRDT events.
 */
export interface Repository {
  /**
   * Retrieves all events stored in the repository.
   */
  getEvents(): Promise<CrdtEvent[]>;

  /**
   * Saves CRDT events to the repository.
   * @param events The CRDT events to save.
   */
  saveEvents(events: CrdtEvent[]): Promise<void>;

  /**
   * Optional helper method to clear all events (useful for resetting document state).
   */
  clearEvents?(): Promise<void>;

  /**
   * Optional helper method to flush any buffered events.
   */
  flush?(): Promise<void>;
}

/**
 * Interface representing the minimal WebSocket capabilities needed by the server library.
 * This ensures compatibility with ws, Hono's raw WebSocket, and other server-side sockets.
 */
export interface MinimalWebSocket {
  send(data: string): void;
  close?(): void;
  readyState: number;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
}

export interface CrdtServerOptions {
  pubSub?: PubSubAdapter;
  /** The number of new events before the server triggers a compaction of the event graph. */
  compactionThreshold?: number;
  /** Maximum size of a single WebSocket message in bytes. Default: 1MB */
  maxMessageSize?: number;
  /** Maximum number of values in an array-insert operation. Default: 10,000 */
  maxArrayInsertSize?: number;
  /** Maximum text length in a text-insert operation. Default: 100,000 */
  maxTextInsertSize?: number;
  /** Maximum value size for a map-set operation in bytes. Default: 100KB */
  maxValueSize?: number;
  /** Maximum events per second per socket. Default: 100 */
  maxEventsPerSecond?: number;
  /** Maximum serialized size in bytes of a single awareness state payload. Default: 100KB */
  maxAwarenessStateSize?: number;
  /** Maximum number of distinct replica ids a single socket may register awareness for. Default: 100 */
  maxReplicaIdsPerSocket?: number;
  /** Time in milliseconds to wait before removing an idle server from the global map. Default: 30,000 */
  idleTimeoutMs?: number;
  /** Optional logger for diagnostics. Defaults to the process-wide logger (see {@link setLogger}). */
  logger?: Logger;
  /**
   * Optional hook invoked when the server catches an error it would otherwise
   * only log — e.g. a failed queued task or a message that could not be
   * processed. Lets callers surface a metric/alert for dropped events instead of
   * only seeing console noise. Errors thrown by the hook itself are ignored.
   */
  onError?: (context: string, error: unknown) => void;
  /**
   * Single-writer/leader guard for clustered deployments. Compaction rewrites
   * the *shared* repository (clear + re-save), so in a multi-process cluster
   * only one process may perform it — otherwise two processes race to wipe and
   * rewrite the same history, corrupting the persisted graph.
   *
   * When several {@link CrdtServer} processes serve the same room over a
   * {@link PubSubAdapter}, provide this hook (backed by your own leader election
   * / distributed lock) so it resolves truthy on exactly one process. A process
   * for which it resolves falsy skips the repository rewrite; it still receives
   * the resulting snapshot over pub/sub and rebuilds its in-memory state from
   * it, so the whole cluster stays converged.
   *
   * Omit it for single-process deployments — compaction then always proceeds.
   */
  canCompact?: () => boolean | Promise<boolean>;
}

/**
 * CrdtServer manages a single collaborative document, its connected clients,
 * and replicates CRDT events across them with persistence through a Repository.
 */
export class CrdtServer {
  private doc: Doc;
  private repository: Repository;
  private sockets = new Set<MinimalWebSocket>();
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private roomId: string;
  private pubSub?: PubSubAdapter;
  private unsubscribeFromPubSub: (() => void) | null = null;
  private socketReplicaIds = new Map<MinimalWebSocket, Set<string>>();
  private compactionThreshold?: number;
  private options?: CrdtServerOptions;
  private eventCountSinceCompaction = 0;
  private messageQueue: (() => Promise<void>)[] = [];
  private isProcessingQueue = false;
  private isCompacting = false;
  private compactionPromise: Promise<void> | null = null;
  private backgroundEventsBuffer: CrdtEvent[] | null = null;
  private serverSequenceNumber: number = 0;
  /**
   * Pending idle-eviction timer scheduled when the last socket disconnects.
   * Retained so a reconnection can cancel it, preventing both timer accumulation
   * and a stale timer from evicting a replacement instance for the same room.
   */
  private idleEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Replica id used to mint snapshot event ids during compaction. It carries a
   * per-instance random suffix so that two {@link CrdtServer} processes serving
   * the same room over pub/sub can never mint the same snapshot id for
   * different snapshot contents (which would make one silently drop the other's
   * snapshot on {@link EventGraph.addEvent} and diverge permanently). It is
   * regenerated per process; if snapshot-id determinism across restarts is
   * required, persist and pass it back via the replica id yourself.
   */
  private snapshotReplicaId: string;
  private logger: Logger;

  /**
   * Reports an error through the configured `onError` hook (if any) and the
   * logger. Used for errors the server recovers from but that a caller may want
   * to observe (e.g. to count dropped events).
   */
  private reportError(context: string, error: unknown) {
    if (this.options?.onError) {
      try {
        this.options.onError(context, error);
      } catch {
        // A faulty error hook must not mask the original error.
      }
    }
    this.logger.error(`${context}:`, error);
  }

  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    try {
      while (this.messageQueue.length > 0) {
        const task = this.messageQueue.shift();
        if (task) {
          try {
            await task();
          } catch (err) {
            this.reportError("Error processing queued task", err);
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  constructor(roomId: string, repository: Repository, options?: CrdtServerOptions) {
    this.logger = options?.logger ?? getLogger();
    this.doc = new Doc(undefined, this.logger);
    this.roomId = roomId;
    this.repository = repository;
    this.pubSub = options?.pubSub;
    this.compactionThreshold = options?.compactionThreshold;
    this.options = options;
    // Process-unique snapshot replica id (see field docs): prevents cross-process
    // snapshot-id collisions when several servers cluster over pub/sub.
    this.snapshotReplicaId = `server-${roomId}-${generateReplicaId()}`;
  }

  /**
   * Initializes the server state by loading existing events from the repository.
   * If the repository is empty, it initializes the document with a default root structure.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
      this.doc.clear(); // Reset document to avoid double-application on re-init
      const events = await this.repository.getEvents();
      if (events.length > 0) {
        this.logger.info(`Loading ${events.length} events from the repository.`);
        this.doc.egWalker.integrateRemote(events);
        
        // Initialize serverSequenceNumber based on existing server snapshot
        // events. Snapshot replica ids are `server-<room>[-<suffix>]`, so match
        // on the prefix to cover both this instance's suffixed ids and any ids
        // written by earlier instances/versions.
        const serverReplicaPrefix = `server-${this.roomId}`;
        for (const event of events) {
          if (event.replicaId.startsWith(serverReplicaPrefix)) {
            const parts = event.id.split(':');
            if (parts.length === 2) {
              const seq = parseInt(parts[1], 10);
              if (!isNaN(seq) && seq >= this.serverSequenceNumber) {
                this.serverSequenceNumber = seq + 1;
              }
            }
          }
        }
      } else {
        this.logger.info("No existing events. Initializing new document.");
        this.doc.getMap().getArray("content").insert(0, []);
        // Persist all seed events explicitly rather than only the last graph
        // event, so the repository holds a complete, replayable history.
        const seedEvents = this.doc.egWalker
          .getStateSnapshot()
          .graph.events.map(([, event]) => event);
        if (seedEvents.length > 0) {
          await this.repository.saveEvents(seedEvents);
        }
      }

      // If a PubSub adapter is configured, subscribe to events for this room
      if (this.pubSub) {
        this.unsubscribeFromPubSub = await this.pubSub.subscribe(this.roomId, (message) => {
          this.messageQueue.push(async () => {
            let shouldBroadcast = true;
            
            if (message.type === "event") {
              // Check if we already integrated this event (e.g. if we published it ourselves)
              if (this.doc.egWalker.graph.getEvent(message.data.id)) {
                shouldBroadcast = false;
              } else {
                this.doc.egWalker.integrateRemote([message.data]);
              }
            } else if (message.type === "snapshot") {
              // Another process in the cluster compacted the shared history and
              // rewrote the repository. Rebuild our in-memory state from its
              // snapshot so we converge, instead of keeping a now-stale full
              // graph whose events reference parents that peer just deleted.
              const snapshotEventId = message.data.graph.events.find(
                ([, event]) => event.op.type === SNAPSHOT_OP
              )?.[0];
              // Skip our own echo (or an already-applied snapshot): if the
              // snapshot's root event is already in our graph we produced or
              // integrated it, and re-loading would drop events that arrived
              // after the snapshot was taken.
              if (snapshotEventId && this.doc.egWalker.graph.getEvent(snapshotEventId)) {
                shouldBroadcast = false;
              } else {
                this.doc.egWalker.loadStateSnapshot(message.data);
              }
            } else if (message.type === "awareness") {
              // A null state signals the replica went offline: delete the entry
              // instead of retaining a growing set of null tombstones across the
              // cluster (the local disconnect path deletes; mirror that here).
              if (message.data.state === null) {
                this.doc.egWalker.awarenessStates.delete(message.data.replicaId);
              } else {
                this.doc.egWalker.awarenessStates.set(message.data.replicaId, message.data.state);
              }
            }

            if (shouldBroadcast) {
              // Broadcast to all locally connected sockets
              const broadcastMsgString = JSON.stringify(message);
              let senderReplicaId: string | undefined;
              if (message.type === "event") {
                senderReplicaId = message.data.replicaId;
              } else if (message.type === "awareness") {
                senderReplicaId = message.data.replicaId;
              }

              for (const client of this.sockets) {
                if (client.readyState === 1) { // OPEN
                  const clientReplicaIds = this.socketReplicaIds.get(client);
                  const isSender = senderReplicaId && clientReplicaIds && clientReplicaIds.has(senderReplicaId);
                  if (!isSender) {
                    client.send(broadcastMsgString);
                  }
                }
              }
            }
          });
          this.processQueue().catch((err) => this.logger.error(err));
        });
      }

      this.initialized = true;
    })();

    return this.initializingPromise;
  }

  /**
   * Handles a new WebSocket connection.
   * Sends the current state snapshot to the client and sets up event listeners to replicate changes.
   */
  async handleConnection(socket: MinimalWebSocket): Promise<void> {
    // Cancel any pending idle-eviction: this instance is being reused.
    if (this.idleEvictionTimer) {
      clearTimeout(this.idleEvictionTimer);
      this.idleEvictionTimer = null;
    }

    await this.initialize();

    this.sockets.add(socket);

    // Send state snapshot to the newly connected client
    const snapshot = this.doc.egWalker.getStateSnapshot();
    const snapshotMsg: ServerMessage = { type: "snapshot", data: snapshot };
    socket.send(JSON.stringify(snapshotMsg));

    const eventTimestamps: number[] = [];
    const maxRate = this.options?.maxEventsPerSecond ?? 100;
    const maxSize = this.options?.maxMessageSize ?? 1_048_576; // 1MB
    let violations = 0;

    socket.on("message", (data: unknown) => {
      const messageString = typeof data === "string" ? data : String(data);
      
      if (messageString.length > maxSize) {
        this.logger.warn(`Rejected oversized message: ${messageString.length} bytes`);
        violations++;
        if (violations > 5) socket.close?.();
        return;
      }

      const now = Date.now();
      eventTimestamps.push(now);
      while (eventTimestamps.length > 0 && eventTimestamps[0] < now - 1000) {
        eventTimestamps.shift();
      }
      if (eventTimestamps.length > maxRate) {
        this.logger.warn(`Rate limit exceeded for socket, dropping event`);
        violations++;
        if (violations > 5) socket.close?.();
        return;
      }

      this.messageQueue.push(async () => {
        try {
          const parsed = JSON.parse(messageString);

          if (parsed.type === "awareness") {
            const { replicaId, state } = parsed.data;

            // Awareness is an unauthenticated, unbounded payload path (unlike
            // events it carries no per-op size caps), so bound it here to prevent
            // memory-growth DoS: reject oversized states and cap the number of
            // distinct replica ids a single socket may register.
            if (typeof replicaId !== "string") return;
            const maxAwarenessSize = this.options?.maxAwarenessStateSize ?? 100 * 1024;
            if (JSON.stringify(state ?? null).length > maxAwarenessSize) {
              this.reportError(
                "Rejected oversized awareness state",
                new Error(`awareness state exceeds ${maxAwarenessSize} bytes`),
              );
              return;
            }

            let ids = this.socketReplicaIds.get(socket);
            if (!ids) {
              ids = new Set();
              this.socketReplicaIds.set(socket, ids);
            }
            const maxReplicaIds = this.options?.maxReplicaIdsPerSocket ?? 100;
            if (!ids.has(replicaId) && ids.size >= maxReplicaIds) {
              this.reportError(
                "Rejected awareness: too many replica ids for one socket",
                new Error(`socket exceeded ${maxReplicaIds} replica ids`),
              );
              return;
            }
            ids.add(replicaId);

            this.doc.egWalker.awarenessStates.set(replicaId, state);

            const broadcastMsg: ServerMessage = { type: "awareness", data: { replicaId, state } };
            const broadcastMsgString = JSON.stringify(broadcastMsg);
            
            if (this.pubSub) {
              await this.pubSub.publish(this.roomId, broadcastMsg);
            } else {
              for (const client of this.sockets) {
                if (client.readyState === 1 && client !== socket) { // Optional: exclude sender
                  client.send(broadcastMsgString);
                }
              }
            }
            return;
          }

          let event: CrdtEvent;
          if (parsed.id && parsed.replicaId) {
            event = parsed;
          } else if (parsed.type === "event") {
            event = parsed.data;
          } else {
            return;
          }

          // Validate the event structure to prevent injection of arbitrary data
          if (!isCrdtEvent(event)) {
            this.logger.warn("Rejected invalid event from client:", event);
            return;
          }

          // Operation-specific size limits
          if (event.op.type === "array-insert") {
            const maxArraySize = this.options?.maxArrayInsertSize ?? 10_000;
            if (event.op.values.length > maxArraySize) {
              this.logger.warn(`Rejected array-insert with ${event.op.values.length} values`);
              return;
            }
          } else if (event.op.type === "text-insert") {
            const maxTextSize = this.options?.maxTextInsertSize ?? 100_000;
            if (event.op.text.length > maxTextSize) {
              this.logger.warn(`Rejected text-insert with ${event.op.text.length} chars`);
              return;
            }
          } else if (event.op.type === "map-set") {
            const maxValueSize = this.options?.maxValueSize ?? 102_400; // 100KB
            if (JSON.stringify(event.op.value).length > maxValueSize) {
              this.logger.warn(`Rejected map-set with value size exceeding limit`);
              return;
            }
          }

          let eventIds = this.socketReplicaIds.get(socket);
          if (!eventIds) {
            eventIds = new Set();
            this.socketReplicaIds.set(socket, eventIds);
          }
          eventIds.add(event.replicaId);

          // Integrate first — integration is tolerant of missing parents (it
          // buffers orphans) and never throws — then persist only what was
          // actually integrated. This guarantees a persisted event is always
          // replayable (all its parents are present), so an out-of-order or
          // orphaned event can never be saved-but-unintegrated and brick the
          // room on reload. `integrated` also includes any previously-buffered
          // events that this one unblocked, so nothing integrated is lost.
          const integrated = this.doc.egWalker.integrateRemote([event]) ?? [];
          if (integrated.length > 0) {
            if (this.compactionPromise) {
              if (this.backgroundEventsBuffer) {
                this.backgroundEventsBuffer.push(...integrated);
              }
            } else {
              await this.repository.saveEvents(integrated);
            }
          }

          // Eagerly broadcast to all local clients
          const broadcastMsg: ServerMessage = { type: "event", data: event };
          const broadcastMsgString = JSON.stringify(broadcastMsg);
          for (const client of this.sockets) {
            if (client.readyState === 1 && client !== socket) { // Optional: exclude sender
              client.send(broadcastMsgString);
            }
          }

          // Publish to cluster if adapter is present
          if (this.pubSub) {
            await this.pubSub.publish(this.roomId, { type: "event", data: event });
          }

          this.eventCountSinceCompaction++;
          if (this.compactionThreshold && this.eventCountSinceCompaction >= this.compactionThreshold) {
            if (!this.isCompacting) {
              this.eventCountSinceCompaction = 0;
              // Already inside a queued task: call the implementation directly
              // (enqueuing would deadlock against this task draining the queue).
              await this.runCompaction();
            }
          }
        } catch (err) {
          this.reportError("Error processing message", err);
        }
      });
      this.processQueue().catch((err) => this.logger.error(err));
    });

    const cleanup = async () => {
      const replicaIds = this.socketReplicaIds.get(socket);
      if (replicaIds) {
        for (const replicaId of replicaIds) {
          this.doc.egWalker.awarenessStates.delete(replicaId);
          const offlineMsg: ServerMessage = { type: "awareness", data: { replicaId, state: null } };
          const offlineMsgStr = JSON.stringify(offlineMsg);
          if (this.pubSub) {
            await this.pubSub.publish(this.roomId, offlineMsg).catch((err) => this.logger.error(err));
          } else {
            for (const client of this.sockets) {
              if (client.readyState === 1 && client !== socket) {
                client.send(offlineMsgStr);
              }
            }
          }
        }
      }
      this.socketReplicaIds.delete(socket);
      this.sockets.delete(socket);
      if (this.sockets.size === 0) {
        // Safe flush of buffered repository if it supports it
        if (typeof this.repository.flush === "function") {
          try {
            await this.repository.flush();
          } catch (err) {
            this.reportError("Failed to flush repository on connection cleanup", err);
          }
        }

        // Re-check after the await: a client may have reconnected during the
        // flush window (handleConnection sees `initialized` still true and adds
        // its socket). If so, do NOT tear down the subscription / reset init state
        // underneath the now-live socket, or it would silently stop receiving
        // pub/sub-relayed peer edits.
        if (this.sockets.size > 0) {
          return;
        }

        // Unsubscribe from Pub/Sub
        if (this.unsubscribeFromPubSub) {
          this.unsubscribeFromPubSub();
          this.unsubscribeFromPubSub = null;
        }

        this.initialized = false;
        this.initializingPromise = null;

        if (this.idleEvictionTimer) {
          clearTimeout(this.idleEvictionTimer);
        }
        this.idleEvictionTimer = setTimeout(() => {
          this.idleEvictionTimer = null;
          // Only evict if still idle AND this exact instance still owns the room
          // key. Without the identity check a stale timer could delete a fresh
          // replacement instance (created after an evict/reset), splitting the
          // room across two live servers with no shared state.
          if (this.sockets.size === 0 && serverInstances.get(this.roomId) === this) {
            serverInstances.delete(this.roomId);
          }
        }, this.options?.idleTimeoutMs ?? 30_000);
      }
    };

    socket.on("close", cleanup);
    socket.on("error", (err: unknown) => {
      this.reportError("WebSocket connection error", err);
      cleanup();
    });
  }

  /**
   * Resets the document state and clears the underlying repository.
   */
  async reset(): Promise<void> {
    if (this.compactionPromise) {
      await this.compactionPromise;
    }
    this.doc = new Doc(undefined, this.logger);
    this.sockets.clear();
    this.socketReplicaIds.clear();

    // Reset lifecycle/bookkeeping flags so a subsequent initialize() actually
    // reloads state instead of short-circuiting on a stale `initialized` flag.
    this.initialized = false;
    this.initializingPromise = null;
    this.eventCountSinceCompaction = 0;
    this.serverSequenceNumber = 0;

    if (this.unsubscribeFromPubSub) {
      this.unsubscribeFromPubSub();
      this.unsubscribeFromPubSub = null;
    }

    if (this.repository.clearEvents) {
      await this.repository.clearEvents();
    }

    this.doc.getMap().getArray("content").insert(0, []);
    // Persist all seed events explicitly (see initialize()).
    const seedEvents = this.doc.egWalker
      .getStateSnapshot()
      .graph.events.map(([, event]) => event);
    if (seedEvents.length > 0) {
      await this.repository.saveEvents(seedEvents);
    }
  }

  /**
   * Compacts the event graph to reduce memory usage and repository size.
   *
   * Rebuilds state at the last critical version, gc's the resulting snapshot to
   * drop tombstones, and rewrites the remaining (post-critical-version) events to
   * hang off the new snapshot event.
   *
   * gc'ing the snapshot is safe here even though tombstones are RGA anchors: an
   * insert can only anchor (`afterId`) to an item its author had visible, so any
   * event that anchors to a deleted item is causally *before* that deletion and
   * hence an ancestor of the critical version — it is folded into the snapshot
   * with its position already resolved, not left among the remaining events. No
   * remaining event can reference a gc'd tombstone. This was the concern in
   * PLAN_10; see `tests/compactionGcAnchorLoss.test.ts` for the reproduction
   * attempt that confirms convergence is preserved.
   *
   * Runs through the single message queue so it can never interleave with an
   * in-flight `saveEvents` from an event task — otherwise a concurrent compaction
   * could clear/rewrite the repository between an event's integration and its
   * persistence, leaving a stale event (with pre-compaction parents) written into
   * the just-cleared store. The internal threshold trigger already runs inside a
   * queued task and calls {@link runCompaction} directly to avoid self-deadlock.
   */
  async compact(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.messageQueue.push(async () => {
        try {
          await this.runCompaction();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.processQueue().catch((err) => this.logger.error(err));
    });
  }

  /**
   * The compaction implementation. Must only be invoked from within the message
   * queue (via {@link compact} or the in-queue threshold trigger) so it is
   * serialised against event persistence.
   */
  private async runCompaction(): Promise<void> {
    if (this.isCompacting) return;
    this.isCompacting = true;
    try {
      // Clustered single-writer guard. Compaction rewrites the shared
      // repository, so in a multi-process cluster only the leader may run it;
      // followers skip and instead rebuild from the leader's snapshot when it
      // is published over pub/sub (see the subscribe handler). `isCompacting`
      // is already set, so this also serialises against concurrent callers.
      if (this.options?.canCompact) {
        let allowed = false;
        try {
          allowed = await this.options.canCompact();
        } catch (err) {
          this.reportError("canCompact hook threw; skipping compaction", err);
          allowed = false;
        }
        if (!allowed) {
          this.isCompacting = false;
          return;
        }
      }

      const version = this.doc.egWalker.graph.getLastCriticalVersion();
      if (version.length === 0) {
        this.isCompacting = false;
        return; // Cannot compact without a critical version
      }

      // Rebuild the state exactly at the critical version to create the snapshot
      const tempDoc = new Doc(undefined, this.logger);
      const eventsToApply = this.doc.egWalker.graph.topologicalSort(
        this.doc.egWalker.graph.getEvents(version)
      );
      tempDoc.egWalker.integrateRemote(eventsToApply);
      // Drop tombstones before saving the snapshot. Safe because no remaining
      // event can anchor into a gc'd tombstone (see compact() docstring / PLAN_10).
      tempDoc.gc(true);
      const snap = tempDoc.getSnapshot();
      const snapshotState = isRecord(snap) ? snap : {};

      const { snapshotEvent, remainingEvents } = this.doc.egWalker.graph.compact(
        version,
        snapshotState,
        this.snapshotReplicaId,
        this.serverSequenceNumber++
      );

      // Replace the internal graph
      const newDoc = new Doc(this.doc.egWalker.getReplicaId(), this.logger);
      newDoc.egWalker.integrateRemote([snapshotEvent, ...remainingEvents]);
      
      // Copy over awareness states
      for (const [key, val] of this.doc.egWalker.awarenessStates.entries()) {
        newDoc.egWalker.awarenessStates.set(key, val);
      }
      this.doc = newDoc;

      if (this.repository.clearEvents) {
        this.backgroundEventsBuffer = [];
        this.compactionPromise = (async () => {
          try {
            await this.repository.clearEvents!();
            await this.repository.saveEvents([snapshotEvent, ...remainingEvents]);
            
            // Save buffered events that arrived during compaction
            while (this.backgroundEventsBuffer && this.backgroundEventsBuffer.length > 0) {
              const bufferToSave = this.backgroundEventsBuffer;
              this.backgroundEventsBuffer = []; // Reset reference to catch new incoming events
              await this.repository.saveEvents(bufferToSave);
            }
          } catch (err) {
            // The rewrite failed, so the persisted store may lag the in-memory
            // graph. This is NOT state loss: every event here is already
            // integrated into `this.doc`, and the next compaction rewrites the
            // full graph, re-persisting everything (self-healing). Only durability
            // across a process crash before the next compaction is at risk.
            this.reportError("Error during background compaction DB I/O", err);
          } finally {
            this.backgroundEventsBuffer = null;
            this.compactionPromise = null;
            this.isCompacting = false;
          }
        })();
      } else {
        this.isCompacting = false;
      }

      // Send snapshot to all clients so they reset their state
      const snapshotMsg: ServerMessage = { type: "snapshot", data: this.doc.egWalker.getStateSnapshot() };
      const snapshotMsgString = JSON.stringify(snapshotMsg);
      for (const client of this.sockets) {
        if (client.readyState === 1) {
          client.send(snapshotMsgString);
        }
      }

      // Publish the snapshot to the rest of the cluster so peer processes rebuild
      // from it instead of retaining a full graph that references history this
      // process just rewrote in the shared repository. Peers dedupe our own echo
      // via the snapshot event id (see the subscribe handler).
      if (this.pubSub) {
        await this.pubSub.publish(this.roomId, snapshotMsg);
      }
    } catch (err) {
      this.isCompacting = false;
      throw err;
    }
  }

  /**
   * Returns the underlying Doc instance.
   */
  getDoc(): Doc {
    return this.doc;
  }

  /**
   * Returns the number of connected clients.
   */
  getConnectedClientsCount(): number {
    return this.sockets.size;
  }
}

// Global Map to store server instances mapped to their roomId
export const serverInstances = new Map<string, CrdtServer>();

/**
 * Exposes a helper function that takes the socket and the repository in parameters
 * and handles WebSocket synchronization, persistence, and broadcasting.
 */
export async function handleWebSocket(
  socket: MinimalWebSocket,
  roomId: string,
  repository: Repository,
  options?: CrdtServerOptions
): Promise<void> {
  let server = serverInstances.get(roomId);
  if (!server) {
    server = new CrdtServer(roomId, repository, options);
    serverInstances.set(roomId, server);
  }
  await server.handleConnection(socket);
}

/**
 * Resets the server instance associated with the given roomId.
 */
export async function resetServer(roomId: string): Promise<void> {
  const server = serverInstances.get(roomId);
  if (server) {
    await server.reset();
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

