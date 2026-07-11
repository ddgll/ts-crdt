import { CrdtEvent, Doc, ServerMessage, isCrdtEvent } from "../index.js";
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
  /** Time in milliseconds to wait before removing an idle server from the global map. Default: 30,000 */
  idleTimeoutMs?: number;
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
            console.error("Error processing queued task:", err);
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  constructor(roomId: string, repository: Repository, options?: CrdtServerOptions) {
    this.doc = new Doc();
    this.roomId = roomId;
    this.repository = repository;
    this.pubSub = options?.pubSub;
    this.compactionThreshold = options?.compactionThreshold;
    this.options = options;
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
        console.log(`Loading ${events.length} events from the repository.`);
        this.doc.egWalker.integrateRemote(events);
      } else {
        console.log("No existing events. Initializing new document.");
        this.doc.getMap().getArray("content").insert(0, []);
        const events = this.doc.egWalker.getStateSnapshot().graph.events;
        const event = events[events.length - 1][1];
        if (event) {
          await this.repository.saveEvents([event]);
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
            } else if (message.type === "awareness") {
              this.doc.egWalker.awarenessStates.set(message.data.replicaId, message.data.state);
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
          this.processQueue().catch(console.error);
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
        console.warn(`Rejected oversized message: ${messageString.length} bytes`);
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
        console.warn(`Rate limit exceeded for socket, dropping event`);
        violations++;
        if (violations > 5) socket.close?.();
        return;
      }

      this.messageQueue.push(async () => {
        try {
          const parsed = JSON.parse(messageString);

          if (parsed.type === "awareness") {
            const { replicaId, state } = parsed.data;
            
            let ids = this.socketReplicaIds.get(socket);
            if (!ids) {
              ids = new Set();
              this.socketReplicaIds.set(socket, ids);
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
            event = parsed as CrdtEvent;
          } else if (parsed.type === "event") {
            event = parsed.data as CrdtEvent;
          } else {
            return;
          }

          // Validate the event structure to prevent injection of arbitrary data
          if (!isCrdtEvent(event)) {
            console.warn("Rejected invalid event from client:", event);
            return;
          }

          // Operation-specific size limits
          if (event.op.type === "array-insert") {
            const maxArraySize = this.options?.maxArrayInsertSize ?? 10_000;
            if (event.op.values.length > maxArraySize) {
              console.warn(`Rejected array-insert with ${event.op.values.length} values`);
              return;
            }
          } else if (event.op.type === "text-insert") {
            const maxTextSize = this.options?.maxTextInsertSize ?? 100_000;
            if (event.op.text.length > maxTextSize) {
              console.warn(`Rejected text-insert with ${event.op.text.length} chars`);
              return;
            }
          } else if (event.op.type === "map-set") {
            const maxValueSize = this.options?.maxValueSize ?? 102_400; // 100KB
            if (JSON.stringify(event.op.value).length > maxValueSize) {
              console.warn(`Rejected map-set with value size exceeding limit`);
              return;
            }
          }

          let eventIds = this.socketReplicaIds.get(socket);
          if (!eventIds) {
            eventIds = new Set();
            this.socketReplicaIds.set(socket, eventIds);
          }
          eventIds.add(event.replicaId);

          // Buffer or persist the event using repository
          if (this.compactionPromise) {
            if (this.backgroundEventsBuffer) {
              this.backgroundEventsBuffer.push(event);
            }
          } else {
            await this.repository.saveEvents([event]);
          }

          // Eagerly integrate locally
          this.doc.egWalker.integrateRemote([event]);

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
              await this.compact();
            }
          }
        } catch (err) {
          console.error("Error processing message:", err);
        }
      });
      this.processQueue().catch(console.error);
    });

    const cleanup = async () => {
      const replicaIds = this.socketReplicaIds.get(socket);
      if (replicaIds) {
        for (const replicaId of replicaIds) {
          this.doc.egWalker.awarenessStates.delete(replicaId);
          const offlineMsg: ServerMessage = { type: "awareness", data: { replicaId, state: null } };
          const offlineMsgStr = JSON.stringify(offlineMsg);
          if (this.pubSub) {
            await this.pubSub.publish(this.roomId, offlineMsg).catch(console.error);
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
            console.error("Failed to flush repository on connection cleanup:", err);
          }
        }

        // Unsubscribe from Pub/Sub
        if (this.unsubscribeFromPubSub) {
          this.unsubscribeFromPubSub();
          this.unsubscribeFromPubSub = null;
        }

        this.initialized = false;
        this.initializingPromise = null;
        
        setTimeout(() => {
          if (this.sockets.size === 0) {
            serverInstances.delete(this.roomId);
          }
        }, this.options?.idleTimeoutMs ?? 30_000);
      }
    };

    socket.on("close", cleanup);
    socket.on("error", (err: unknown) => {
      console.error("WebSocket connection error:", err);
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
    this.doc = new Doc();
    this.sockets.clear();
    this.socketReplicaIds.clear();
    
    if (this.unsubscribeFromPubSub) {
      this.unsubscribeFromPubSub();
      this.unsubscribeFromPubSub = null;
    }

    if (this.repository.clearEvents) {
      await this.repository.clearEvents();
    }

    this.doc.getMap().getArray("content").insert(0, []);
    const events = this.doc.egWalker.getStateSnapshot().graph.events;
    const event = events[events.length - 1][1];
    if (event) {
      await this.repository.saveEvents([event]);
    }
  }

  /**
   * Compacts the event graph to reduce memory usage and repository size.
   */
  async compact(): Promise<void> {
    if (this.isCompacting) return;
    this.isCompacting = true;
    try {
      const version = this.doc.egWalker.graph.getLastCriticalVersion();
      if (version.length === 0) {
        this.isCompacting = false;
        return; // Cannot compact without a critical version
      }

      // Rebuild the state exactly at the critical version to create the snapshot
      const tempDoc = new Doc();
      const eventsToApply = this.doc.egWalker.graph.topologicalSort(
        this.doc.egWalker.graph.getEvents(version)
      );
      tempDoc.egWalker.integrateRemote(eventsToApply);
      // Perform garbage collection to remove tombstones before saving snapshot
      tempDoc.gc(true);
      const snapshotState = tempDoc.getSnapshot() as Record<string, unknown>;

      const { snapshotEvent, remainingEvents } = this.doc.egWalker.graph.compact(
        version,
        snapshotState,
        `server-${this.roomId}`,
        Date.now()
      );

      // Replace the internal graph
      const newDoc = new Doc(this.doc.egWalker.getReplicaId());
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
            if (this.backgroundEventsBuffer && this.backgroundEventsBuffer.length > 0) {
              await this.repository.saveEvents(this.backgroundEventsBuffer);
            }
          } catch (err) {
            console.error("Error during background compaction DB I/O:", err);
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
