import { CrdtEvent, Doc } from "@ddgll/ts-crdt";

/**
 * Interface representing a repository to persist and load CRDT events.
 */
export interface Repository {
  /**
   * Retrieves all events stored in the repository.
   */
  getEvents(): Promise<CrdtEvent[]>;

  /**
   * Saves a new event to the repository.
   * @param event The CRDT event to save.
   */
  saveEvent(event: CrdtEvent): Promise<void>;

  /**
   * Optional helper method to clear all events (useful for resetting document state).
   */
  clearEvents?(): Promise<void>;
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

  constructor(repository: Repository) {
    this.doc = new Doc();
    this.repository = repository;
  }

  /**
   * Initializes the server state by loading existing events from the repository.
   * If the repository is empty, it initializes the document with a default root structure.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
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
          await this.repository.saveEvent(event);
        }
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
    socket.send(JSON.stringify({ type: "snapshot", data: snapshot }));

    socket.on("message", async (data: unknown) => {
      try {
        const messageString = typeof data === "string" ? data : String(data);
        const event: CrdtEvent = JSON.parse(messageString);

        // Persist the event first
        await this.repository.saveEvent(event);

        // Integrate the event into the local document
        this.doc.egWalker.integrateRemote([event]);

        // Broadcast to all clients
        const broadcastMsg = JSON.stringify({ type: "event", data: event });
        for (const client of this.sockets) {
          if (client.readyState === 1) { // OPEN
            client.send(broadcastMsg);
          }
        }
      } catch (err) {
        console.error("Error processing message:", err);
      }
    });

    const cleanup = () => {
      this.sockets.delete(socket);
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
    
    if (this.repository.clearEvents) {
      await this.repository.clearEvents();
    }

    const event = this.doc.localInsert(["content"], 0, []);
    if (event) {
      await this.repository.saveEvent(event);
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

// Global WeakMap to store server instances mapped to their repositories
const serverInstances = new WeakMap<Repository, CrdtServer>();

/**
 * Exposes a helper function that takes the socket and the repository in parameters
 * and handles WebSocket synchronization, persistence, and broadcasting.
 */
export async function handleWebSocket(socket: MinimalWebSocket, repository: Repository): Promise<void> {
  let server = serverInstances.get(repository);
  if (!server) {
    server = new CrdtServer(repository);
    serverInstances.set(repository, server);
  }
  await server.handleConnection(socket);
}

/**
 * Resets the server instance associated with the given repository.
 */
export async function resetServer(repository: Repository): Promise<void> {
  const server = serverInstances.get(repository);
  if (server) {
    await server.reset();
  }
}
