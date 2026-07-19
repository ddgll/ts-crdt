import { Doc, ServerMessage, YArray, YText, YMap, CrdtEvent, SNAPSHOT_OP } from "./index.js";
import { Logger, getLogger } from "./logger.js";

/**
 * Minimal WebSocket interface required by CrdtClient.
 * Conforming to standard browser WebSocket and ws library in Node.
 */
export interface MinimalClientWebSocket {
  send(data: string): void;
  readyState: number; // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
  addEventListener(type: "message", cb: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: () => void): void;
  addEventListener(type: "error", cb: (err: unknown) => void): void;
  addEventListener(type: "open", cb: () => void): void;
  removeEventListener?(type: "message", cb: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "open", cb: () => void): void;
}

/**
 * CrdtClient binds a local Doc instance to a collaborative server via WebSockets.
 * It automatically propagates local operations to the server and integrates remote operations.
 */
export class CrdtClient {
  private doc: Doc;
  private socket: MinimalClientWebSocket | null = null;
  private isApplyingRemote = false;
  private unsubscribeDocListener: (() => void) | null = null;
  private handleMessageRef: ((msgEvent: { data: unknown }) => void) | null = null;
  private handleOpenRef: (() => void) | null = null;
  private messageListeners = new Set<(type: "snapshot" | "event" | "awareness", data: unknown) => void>();
  private logger: Logger;
  /**
   * Local events awaiting delivery to the server. This queue lives for the
   * lifetime of the client (independent of any single socket) so that edits
   * made while disconnected survive reconnection and are replayed once a socket
   * is open again. Events are enqueued when observed and drained on flush.
   */
  private pendingLocalEvents: CrdtEvent[] = [];

  constructor(doc: Doc, logger: Logger = getLogger()) {
    this.doc = doc;
    this.logger = logger;

    // Observe local changes for the entire lifetime of the client, not just
    // while a socket is bound. Edits produced while offline are queued here and
    // replayed on (re)connect instead of being silently dropped.
    this.unsubscribeDocListener = this.doc.egWalker.onEvent((event, isLocal) => {
      if (isLocal && !this.isApplyingRemote) {
        this.enqueueLocalEvent(event);
        this.flushPendingEvents();
      }
    });
  }

  /**
   * Binds the client to a WebSocket connection.
   * Sets up listeners to synchronize the document.
   */
  bind(socket: MinimalClientWebSocket): void {
    if (this.socket) {
      throw new Error("CrdtClient is already bound to a socket. Call unbind() first (or use rebind()).");
    }
    this.socket = socket;

    this.handleMessageRef = (msgEvent: { data: unknown }) => {
      try {
        const msgStr = typeof msgEvent.data === "string" ? msgEvent.data : String(msgEvent.data);
        const parsed: ServerMessage = JSON.parse(msgStr);

        this.isApplyingRemote = true;

        if (parsed.type === "snapshot") {
          // A snapshot load is destructive: it replaces the whole graph with the
          // server's state. Capture ALL locally-held events first — not just our
          // own — so that peer events we had already integrated and displayed but
          // which the incoming snapshot happens to lack (e.g. a server restart
          // with an un-flushed buffer, or a stale cross-process snapshot) are not
          // silently erased by the load.
          const replicaId = this.doc.egWalker.getReplicaId();
          const localEventsBefore = this.doc.egWalker.graph.getAllEvents();

          this.doc.egWalker.loadStateSnapshot(parsed.data);

          // Re-integrate every locally-held event the snapshot doesn't contain so
          // reconnection converges (offline edits and already-seen peer edits
          // survive) instead of dropping data. Only our OWN events are re-queued
          // for delivery to the server; peer events are re-delivered by their
          // authors / the server as needed.
          //
          // Crucially, an event absent from the snapshot's graph is NOT
          // necessarily lost: server compaction FOLDS history into a snapshot
          // event whose `folded` state-vector records, per replica, the highest
          // sequence it absorbed. An event covered by that vector is already
          // reflected in the snapshot state — re-applying it would duplicate
          // content — so only events beyond the vector are re-integrated.
          const graph = this.doc.egWalker.graph;
          const foldedVector = new Map<string, number>();
          for (const ev of graph.getAllEvents()) {
            if (ev.op.type === SNAPSHOT_OP && ev.op.folded) {
              for (const [rid, seq] of Object.entries(ev.op.folded)) {
                if (typeof seq === "number") {
                  const prev = foldedVector.get(rid);
                  if (prev === undefined || prev < seq) foldedVector.set(rid, seq);
                }
              }
            }
          }
          const isFoldedIntoSnapshot = (event: CrdtEvent): boolean => {
            const [rid, seqStr] = event.id.split(":");
            const covered = foldedVector.get(rid);
            return covered !== undefined && parseInt(seqStr, 10) <= covered;
          };
          const missing = localEventsBefore.filter(
            (event) =>
              graph.getEvent(event.id) === undefined &&
              !isFoldedIntoSnapshot(event),
          );
          if (missing.length > 0) {
            this.doc.egWalker.integrateRemote(missing);
            const ownMissing = missing.filter(
              (event) => event.replicaId === replicaId,
            );
            for (const event of ownMissing) {
              this.enqueueLocalEvent(event);
            }
            if (ownMissing.length > 0) {
              this.flushPendingEvents();
            }
          }

          this.notifyListeners("snapshot", parsed.data);
        } else if (parsed.type === "event") {
          const event = parsed.data;
          // Avoid integrating our own events if they are broadcasted back
          if (event.replicaId !== this.doc.egWalker.getReplicaId()) {
            this.doc.egWalker.integrateRemote([event]);
          }
          this.notifyListeners("event", event);
        } else if (parsed.type === "awareness") {
          const { replicaId, state } = parsed.data;
          if (replicaId !== this.doc.egWalker.getReplicaId()) {
            this.doc.egWalker.awarenessStates.set(replicaId, state);
          }
          this.notifyListeners("awareness", parsed.data);
        }
      } catch (err) {
        this.logger.error("[CrdtClient] Error processing message:", err);
      } finally {
        this.isApplyingRemote = false;
      }
    };

    socket.addEventListener("message", this.handleMessageRef);

    // On (re)connect, replay everything the server may be missing. Some sockets
    // are already OPEN by the time they are handed to bind() (e.g. on rebind of
    // a pre-connected socket), in which case "open" has already fired, so flush
    // eagerly as well.
    this.handleOpenRef = () => this.flushPendingEvents();
    socket.addEventListener("open", this.handleOpenRef);
    if (socket.readyState === 1) { // OPEN
      this.flushPendingEvents();
    }
  }

  /**
   * Unbinds the client from the WebSocket connection, cleaning up the socket
   * listeners. The document listener and the pending-event queue intentionally
   * survive so that edits made while unbound are replayed by a later bind()/
   * rebind().
   */
  unbind(): void {
    if (this.socket && this.socket.removeEventListener) {
      if (this.handleMessageRef) {
        this.socket.removeEventListener("message", this.handleMessageRef);
      }
      if (this.handleOpenRef) {
        this.socket.removeEventListener("open", this.handleOpenRef);
      }
    }
    this.handleMessageRef = null;
    this.handleOpenRef = null;
    this.socket = null;
  }

  /**
   * Rebinds the client to a fresh socket after a disconnect. Prefer this over a
   * manual unbind()/bind() pair for reconnection: the pending-event queue and
   * the document listener are preserved, so local edits accumulated while the
   * previous socket was down are replayed to the server once the new socket is
   * open.
   * @param socket The new WebSocket connection to bind to.
   */
  rebind(socket: MinimalClientWebSocket): void {
    this.unbind();
    this.bind(socket);
  }

  /**
   * Queues a local event for delivery to the server, de-duplicating by event id
   * so an event observed both via the document listener and via snapshot
   * recovery is never sent twice.
   */
  private enqueueLocalEvent(event: CrdtEvent): void {
    if (this.pendingLocalEvents.some((e) => e.id === event.id)) {
      return;
    }
    this.pendingLocalEvents.push(event);
  }

  /**
   * Sends all queued local events to the server if a socket is currently open,
   * clearing the queue on send. If no socket is open the events stay queued and
   * are retried on the next flush (e.g. when a socket opens or a snapshot is
   * received on reconnect). Re-sending an event the server already has is safe:
   * server-side integration is idempotent.
   */
  private flushPendingEvents(): void {
    if (!this.socket || this.socket.readyState !== 1) { // not OPEN
      return;
    }
    if (this.pendingLocalEvents.length === 0) {
      return;
    }
    const toSend = this.pendingLocalEvents;
    this.pendingLocalEvents = [];
    for (const event of toSend) {
      this.socket.send(JSON.stringify({ type: "event", data: event }));
    }
  }

  /**
   * Sets the local awareness state and broadcasts it to other replicas.
   * @param state The awareness state to broadcast.
   */
  setAwareness(state: unknown): void {
    this.doc.egWalker.setAwareness(state);
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify({
        type: "awareness",
        data: { replicaId: this.doc.egWalker.getReplicaId(), state }
      }));
    }
  }

  /**
   * Register a custom listener to receive raw sync events/snapshots/awareness.
   */
  onMessage(cb: (type: "snapshot" | "event" | "awareness", data: unknown) => void): () => void {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  private notifyListeners(type: "snapshot" | "event" | "awareness", data: unknown) {
    for (const listener of this.messageListeners) {
      try {
        listener(type, data);
      } catch (err) {
        this.logger.error("[CrdtClient] Listener error:", err);
      }
    }
  }

  /**
   * Returns whether the client is currently applying remote updates to the document.
   */
  isApplyingRemoteChanges(): boolean {
    return this.isApplyingRemote;
  }

  /**
   * Returns the underlying Doc instance.
   */
  getDoc(): Doc {
    return this.doc;
  }

  /**
   * Resolves the CRDT instance at the given path starting from the root map.
   */
  private resolvePath(path: (string | number)[]): unknown {
    let current: unknown = this.doc.getMap();
    for (const segment of path) {
      if (current instanceof YMap) {
        current = current.get(String(segment));
      } else if (current instanceof YArray) {
        current = current.get(Number(segment));
      } else {
        return undefined;
      }
    }
    return current;
  }

  /**
   * Synchronizes a local string value with a collaborative text container (either YArray of characters or YText)
   * at the specified path. It calculates the minimal set of delete and insert operations and applies them.
   * 
   * @param path The path of the target container in the document.
   * @param newText The new text value to synchronize.
   * @param type Optional preference for the container type ("array" | "text") if it doesn't exist yet. Defaults to "text".
   */
  syncText(path: (string | number)[], newText: string, type: "array" | "text" = "text"): void {
    const target = this.resolvePath(path);
    
    let oldText = "";
    let isTextOp = type === "text";

    if (target instanceof YText) {
      oldText = target.toString();
      isTextOp = true;
    } else if (target instanceof YArray) {
      oldText = target.toJSON().map(item => typeof item === "string" ? item : "").join("");
      isTextOp = false;
    }

    if (newText === oldText) {
      return;
    }

    // Diff on code points (not UTF-16 code units) so an edit that changes one
    // emoji to another never cuts through a surrogate pair and leaves a lone
    // surrogate. The resulting boundaries are then expressed in code-unit offsets
    // (`start`/`deletedLength`), which is what YText/YArray indices use.
    const oldCP = Array.from(oldText);
    const newCP = Array.from(newText);

    let prefix = 0;
    while (
      prefix < oldCP.length &&
      prefix < newCP.length &&
      oldCP[prefix] === newCP[prefix]
    ) {
      prefix++;
    }

    let oldEndCP = oldCP.length;
    let newEndCP = newCP.length;
    while (
      oldEndCP > prefix &&
      newEndCP > prefix &&
      oldCP[oldEndCP - 1] === newCP[newEndCP - 1]
    ) {
      oldEndCP--;
      newEndCP--;
    }

    // Code-unit offset of the prefix and the code-unit length of the deleted span.
    const start = oldCP.slice(0, prefix).join("").length;
    const deletedLength = oldCP.slice(prefix, oldEndCP).join("").length;
    const insertedText = newCP.slice(prefix, newEndCP).join("");

    if (target) {
      if (target instanceof YText) {
        if (deletedLength > 0) target.delete(start, deletedLength);
        if (insertedText.length > 0) target.insert(start, insertedText);
      } else if (target instanceof YArray) {
        if (deletedLength > 0) target.delete(start, deletedLength);
        if (insertedText.length > 0) target.insert(start, insertedText.split(""));
      }
    } else {
      if (insertedText.length > 0) {
        if (isTextOp) {
          this.doc.egWalker.localOp({
            type: "text-insert",
            path,
            afterId: null,
            text: insertedText,
          });
        } else {
          this.doc.egWalker.localOp({
            type: "array-insert",
            path,
            afterId: null,
            values: insertedText.split(""),
          });
        }
      }
    }
  }
}
