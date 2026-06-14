import { CrdtEvent, Doc, ServerMessage, ClientMessage } from "../index.js";
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

  constructor(roomId: string, repository: Repository, options?: CrdtServerOptions) {
    this.doc = new Doc();
    this.roomId = roomId;
    this.repository = repository;
    this.pubSub = options?.pubSub;
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
        events.forEach((e) => {
          this.doc.egWalker.integrateRemote([e]);
        });
      } else {
        console.log("No existing events. Initializing new document.");
        const event = this.doc.localInsert(["content"], 0, []);
        if (event) {
          await this.repository.saveEvents([event]);
        }
      }

      // If a PubSub adapter is configured, subscribe to events for this room
      if (this.pubSub) {
        this.unsubscribeFromPubSub = await this.pubSub.subscribe(this.roomId, (event) => {
          // Integrate the event received from the cluster
          this.doc.egWalker.integrateRemote([event]);

          // Broadcast to all locally connected sockets
          const broadcastMsg: ServerMessage = { type: "event", data: event };
          const broadcastMsgString = JSON.stringify(broadcastMsg);
          for (const client of this.sockets) {
            if (client.readyState === 1) { // OPEN
              client.send(broadcastMsgString);
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
        const event: ClientMessage = JSON.parse(messageString);

        // Persist the event first using repository
        await this.repository.saveEvents([event]);

        // Publish to cluster if adapter is present, otherwise integrate and broadcast locally
        if (this.pubSub) {
          await this.pubSub.publish(this.roomId, event);
        } else {
          // Standalone mode: integrate locally
          this.doc.egWalker.integrateRemote([event]);

          // Standalone mode: broadcast to all local clients
          const broadcastMsg: ServerMessage = { type: "event", data: event };
          const broadcastMsgString = JSON.stringify(broadcastMsg);
          for (const client of this.sockets) {
            if (client.readyState === 1) { // OPEN
              client.send(broadcastMsgString);
            }
          }
        }
      } catch (err) {
        console.error("Error processing message:", err);
      }
    });

    const cleanup = async () => {
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
