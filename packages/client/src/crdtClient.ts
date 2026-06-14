import { Doc, ServerMessage, YArray, YText, YMap } from "@ddgll/ts-crdt";

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
  private messageListeners = new Set<(type: "snapshot" | "event", data: unknown) => void>();

  constructor(doc: Doc) {
    this.doc = doc;
  }

  /**
   * Binds the client to a WebSocket connection.
   * Sets up listeners to synchronize the document.
   */
  bind(socket: MinimalClientWebSocket): void {
    if (this.socket) {
      throw new Error("CrdtClient is already bound to a socket. Call unbind() first.");
    }
    this.socket = socket;

    // Listen to local changes in the document to replicate them to the server
    this.unsubscribeDocListener = this.doc.egWalker.onEvent((event, isLocal) => {
      if (isLocal && !this.isApplyingRemote) {
        if (this.socket && this.socket.readyState === 1) { // OPEN
          this.socket.send(JSON.stringify(event));
        }
      }
    });

    const handleMessage = (msgEvent: { data: unknown }) => {
      try {
        const msgStr = typeof msgEvent.data === "string" ? msgEvent.data : String(msgEvent.data);
        const parsed = JSON.parse(msgStr) as ServerMessage;

        this.isApplyingRemote = true;

        if (parsed.type === "snapshot") {
          this.doc.egWalker.loadStateSnapshot(parsed.data);
          this.notifyListeners("snapshot", parsed.data);
        } else if (parsed.type === "event") {
          const event = parsed.data;
          // Avoid integrating our own events if they are broadcasted back
          if (event.replicaId !== this.doc.egWalker.getReplicaId()) {
            this.doc.egWalker.integrateRemote([event]);
          }
          this.notifyListeners("event", event);
        }
      } catch (err) {
        console.error("[CrdtClient] Error processing message:", err);
      } finally {
        this.isApplyingRemote = false;
      }
    };

    socket.addEventListener("message", handleMessage);
  }

  /**
   * Unbinds the client from the WebSocket connection, cleaning up listeners.
   */
  unbind(): void {
    if (this.unsubscribeDocListener) {
      this.unsubscribeDocListener();
      this.unsubscribeDocListener = null;
    }
    this.socket = null;
  }

  /**
   * Register a custom listener to receive raw sync events/snapshots (e.g. to update the UI).
   */
  onMessage(cb: (type: "snapshot" | "event", data: unknown) => void): () => void {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  private notifyListeners(type: "snapshot" | "event", data: unknown) {
    for (const listener of this.messageListeners) {
      try {
        listener(type, data);
      } catch (err) {
        console.error("[CrdtClient] Listener error:", err);
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
        current = current.get(segment as string);
      } else if (current instanceof YArray) {
        current = current.get(segment as number);
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
   * @param type Optional preference for the container type ("array" | "text") if it doesn't exist yet. Defaults to "array".
   */
  syncText(path: (string | number)[], newText: string, type: "array" | "text" = "array"): void {
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

    let start = 0;
    while (
      start < oldText.length &&
      start < newText.length &&
      oldText[start] === newText[start]
    ) {
      start++;
    }

    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (
      oldEnd > start &&
      newEnd > start &&
      oldEnd <= oldText.length &&
      newEnd <= newText.length &&
      oldText[oldEnd - 1] === newText[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }

    const deletedLength = oldEnd - start;
    const insertedText = newText.substring(start, newEnd);

    if (isTextOp) {
      if (deletedLength > 0) {
        this.doc.egWalker.localOp({
          type: "text-delete",
          path,
          index: start,
          length: deletedLength,
        });
      }
      if (insertedText.length > 0) {
        this.doc.egWalker.localOp({
          type: "text-insert",
          path,
          index: start,
          text: insertedText,
        });
      }
    } else {
      if (deletedLength > 0) {
        this.doc.localDelete(path, start, deletedLength);
      }
      if (insertedText.length > 0) {
        this.doc.localInsert(path, start, insertedText.split(""));
      }
    }
  }
}
