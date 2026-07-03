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
  readyState: number;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
}

export interface CrdtServerOptions {
  pubSub?: PubSubAdapter;
  /** The number of new events before the server triggers a compaction of the event graph. */
  compactionThreshold?: number;
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
  private eventCountSinceCompaction = 0;

  constructor(roomId: string, repository: Repository, options?: CrdtServerOptions) {
    this.doc = new Doc();
    this.roomId = roomId;
    this.repository = repository;
    this.pubSub = options?.pubSub;
    this.compactionThreshold = options?.compactionThreshold;
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
        const event = this.doc.localInsert(["content"], 0, []);
        if (event) {
          await this.repository.saveEvents([event]);
        }
      }

      // If a PubSub adapter is configured, subscribe to events for this room
      if (this.pubSub) {
        this.unsubscribeFromPubSub = await this.pubSub.subscribe(this.roomId, (message) => {
          if (message.type === "event") {
            // Integrate the event received from the cluster
            this.doc.egWalker.integrateRemote([message.data]);
          } else if (message.type === "awareness") {
            this.doc.egWalker.awarenessStates.set(message.data.replicaId, message.data.state);
          }

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

    socket.on("message", async (data: unknown) => {
      try {
        const messageString = typeof data === "string" ? data : String(data);
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
          console.warn("Rejected invalid event from client:", event.id);
          return;
        }

        let eventIds = this.socketReplicaIds.get(socket);
        if (!eventIds) {
          eventIds = new Set();
          this.socketReplicaIds.set(socket, eventIds);
        }
        eventIds.add(event.replicaId);

        // Persist the event first using repository
        await this.repository.saveEvents([event]);

        // Publish to cluster if adapter is present, otherwise integrate and broadcast locally
        if (this.pubSub) {
          await this.pubSub.publish(this.roomId, { type: "event", data: event });
        } else {
          // Standalone mode: integrate locally
          this.doc.egWalker.integrateRemote([event]);

          // Standalone mode: broadcast to all local clients
          const broadcastMsg: ServerMessage = { type: "event", data: event };
          const broadcastMsgString = JSON.stringify(broadcastMsg);
          for (const client of this.sockets) {
            if (client.readyState === 1 && client !== socket) { // Optional: exclude sender
              client.send(broadcastMsgString);
            }
          }
        }

        this.eventCountSinceCompaction++;
        if (this.compactionThreshold && this.eventCountSinceCompaction >= this.compactionThreshold) {
          this.eventCountSinceCompaction = 0;
          await this.compact();
        }
      } catch (err) {
        console.error("Error processing message:", err);
      }
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

    const event = this.doc.localInsert(["content"], 0, []);
    if (event) {
      await this.repository.saveEvents([event]);
    }
  }

  /**
   * Compacts the event graph to reduce memory usage and repository size.
   */
  async compact(): Promise<void> {
    const version = this.doc.egWalker.graph.getLastCriticalVersion();
    if (version.length === 0) return; // Cannot compact without a critical version

    // Rebuild the state exactly at the critical version to create the snapshot
    const tempDoc = new Doc();
    const eventsToApply = this.doc.egWalker.graph.topologicalSort(
      this.doc.egWalker.graph.getEvents(version)
    );
    tempDoc.egWalker.integrateRemote(eventsToApply);
    const snapshotState = tempDoc.toJSON();

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
      await this.repository.clearEvents();
      await this.repository.saveEvents([snapshotEvent, ...remainingEvents]);
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
const serverInstances = new Map<string, CrdtServer>();

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
