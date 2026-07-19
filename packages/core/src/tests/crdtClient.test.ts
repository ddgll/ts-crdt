import { describe, it, expect } from 'vitest';
import { Doc, CrdtEvent } from "../index.js";
import { CrdtClient, MinimalClientWebSocket } from "../crdtClient.js";

class MockClientWebSocket implements MinimalClientWebSocket {
  sentData: string[] = [];
  readyState = 1; // OPEN

  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {
    message: [],
    close: [],
    error: [],
    open: [],
  };

  send(data: string): void {
    this.sentData.push(data);
  }

  addEventListener(
    type: "message" | "close" | "error" | "open",
    cb: ((event: { data: unknown }) => void) | (() => void) | ((err: unknown) => void)
  ): void {
    this.listeners[type].push(cb as (...args: unknown[]) => void);
  }

  removeEventListener(
    type: "message" | "close" | "error" | "open",
    cb: ((event: { data: unknown }) => void) | (() => void) | ((err: unknown) => void)
  ): void {
    const index = this.listeners[type].indexOf(cb as (...args: unknown[]) => void);
    if (index !== -1) {
      this.listeners[type].splice(index, 1);
    }
  }

  getListenerCount(type: "message" | "close" | "error" | "open"): number {
    return this.listeners[type].length;
  }

  emit(type: "message", event: { data: unknown }): void;
  emit(type: "close"): void;
  emit(type: "error", err: unknown): void;
  emit(type: "open"): void;
  emit(type: string, ...args: unknown[]): void {
    this.listeners[type]?.forEach((cb) => cb(...args));
  }
}

describe("CrdtClient", () => {
  it("should send local changes to the server", () => {
    const doc = new Doc("client-replica");
    const client = new CrdtClient(doc);
    const ws = new MockClientWebSocket();

    client.bind(ws);

    // Perform local change
    doc.getMap().set("hello", "world");

    // Local changes should be sent
    expect(ws.sentData.length).toBe(1);
    const parsed = JSON.parse(ws.sentData[0]);
    expect(parsed.type).toBe("event");
    expect(parsed.data.op.type).toBe("map-set");
    expect(parsed.data.op.key).toBe("hello");
    expect(parsed.data.op.value).toBe("world");

    client.unbind();
  });

  it("should integrate remote events and snapshots", () => {
    const doc = new Doc("client-replica");
    const client = new CrdtClient(doc);
    const ws = new MockClientWebSocket();

    client.bind(ws);

    // Send a snapshot from server to client
    const sourceDoc = new Doc("server-doc");
    sourceDoc.getMap().set("key1", "val1");
    const snapshot = sourceDoc.egWalker.getStateSnapshot();

    ws.emit("message", {
      data: JSON.stringify({
        type: "snapshot",
        data: snapshot,
      }),
    });

    // Client document should match the snapshot
    expect(doc.getMap().get("key1")).toBe("val1");

    // Send an event from server to client (from another replica)
    const anotherDoc = new Doc("another-replica");
    // Connect it conceptually to the snapshot version by copying
    anotherDoc.egWalker.loadStateSnapshot(snapshot);
    const event = anotherDoc.getMap().set("key2", "val2");

    ws.emit("message", {
      data: JSON.stringify({
        type: "event",
        data: event,
      }),
    });

    // Client document should update
    expect(doc.getMap().get("key2")).toBe("val2");

    client.unbind();
  });

  it("should trigger message callbacks", () => {
    const doc = new Doc("client-replica");
    const client = new CrdtClient(doc);
    const ws = new MockClientWebSocket();

    const messagesReceived: { type: string; data: unknown }[] = [];
    client.onMessage((type, data) => {
      messagesReceived.push({ type, data });
    });

    client.bind(ws);

    const event: CrdtEvent = {
      id: "another:0",
      replicaId: "another",
      parents: [],
      op: {
        type: "map-set",
        path: [],
        key: "x",
        value: 123,
      },
    };

    ws.emit("message", {
      data: JSON.stringify({
        type: "event",
        data: event,
      }),
    });

    expect(messagesReceived.length).toBe(1);
    expect(messagesReceived[0].type).toBe("event");
    const receivedEvent = messagesReceived[0].data as CrdtEvent;
    expect(receivedEvent.id).toBe("another:0");

    client.unbind();
  });

  it("should cleanly remove message listeners on unbind", () => {
    const doc = new Doc("client-replica");
    const client = new CrdtClient(doc);
    const ws = new MockClientWebSocket();

    client.bind(ws);
    expect(ws.getListenerCount("message")).toBe(1);

    client.unbind();
    expect(ws.getListenerCount("message")).toBe(0);
  });

  describe("reconnect resync", () => {
    it("preserves and replays offline edits across a genuinely severed socket", () => {
      const doc = new Doc("client-A");
      const client = new CrdtClient(doc);

      // Server's initial state (some pre-existing content).
      const serverDoc = new Doc("server");
      serverDoc.getMap().set("base", "1");
      const initialSnapshot = serverDoc.egWalker.getStateSnapshot();

      // 1. Connect and receive the initial snapshot.
      const ws1 = new MockClientWebSocket();
      client.bind(ws1);
      ws1.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: initialSnapshot }),
      });
      expect(doc.getMap().get("base")).toBe("1");
      const sentWhileOnline = ws1.sentData.length;

      // 2. Genuinely sever the socket: mark it CLOSED and drop the object.
      ws1.readyState = 3; // CLOSED
      ws1.emit("close");

      // 3. Make an edit while offline. It must not be lost and cannot be sent
      //    over the severed socket.
      doc.getMap().set("offline", "yes");
      expect(doc.getMap().get("offline")).toBe("yes");
      expect(ws1.sentData.length).toBe(sentWhileOnline);

      // 4. Reconnect with a brand-new socket object via rebind().
      const ws2 = new MockClientWebSocket(); // OPEN
      client.rebind(ws2);

      // 5. Server greets the new socket with a snapshot that predates the
      //    offline edit (the server never received it).
      ws2.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: initialSnapshot }),
      });

      // The offline edit survived the destructive snapshot load...
      expect(doc.getMap().get("offline")).toBe("yes");
      expect(doc.getMap().get("base")).toBe("1");

      // ...and was replayed to the server over the new socket.
      const offlineSends = ws2.sentData
        .map((s) => JSON.parse(s))
        .filter(
          (m) =>
            m.type === "event" &&
            m.data.op.type === "map-set" &&
            m.data.op.key === "offline",
        );
      expect(offlineSends.length).toBeGreaterThan(0);

      client.unbind();
    });

    it("preserves already-integrated peer events a snapshot is missing (B3)", () => {
      const doc = new Doc("client-A");
      const client = new CrdtClient(doc);

      const serverDoc = new Doc("server");
      serverDoc.getMap().set("base", "1");
      const initialSnapshot = serverDoc.egWalker.getStateSnapshot();

      const ws = new MockClientWebSocket();
      client.bind(ws);
      ws.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: initialSnapshot }),
      });

      // A peer's event, relayed to the client and integrated, that the server has
      // NOT persisted yet (e.g. it was still in a buffer when the server restarted).
      const peer = new Doc("peer");
      peer.egWalker.integrateRemote(serverDoc.egWalker.graph.getAllEvents());
      peer.getMap().set("peerKey", "peerVal");
      const peerEvent = peer.egWalker.graph
        .getAllEvents()
        .find((e) => e.op.type === "map-set" && (e.op as { key: string }).key === "peerKey")!;
      ws.emit("message", {
        data: JSON.stringify({ type: "event", data: peerEvent }),
      });
      expect(doc.getMap().get("peerKey")).toBe("peerVal");

      // The client makes its own edit causally after the peer's.
      doc.getMap().set("mine", "x");

      // A recovery snapshot arrives that lacks BOTH the peer event and our edit.
      ws.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: initialSnapshot }),
      });

      // Neither the peer's data nor our own is lost, and our edit is not orphaned.
      expect(doc.getMap().get("peerKey")).toBe("peerVal");
      expect(doc.getMap().get("mine")).toBe("x");
      expect(doc.egWalker.getPendingEventCount()).toBe(0);

      client.unbind();
    });

    it("does not duplicate content when receiving a post-compaction snapshot", () => {
      // Mirrors e2e/reconnect-compacted.spec.ts: the client already holds the
      // full pre-compaction history; the compaction snapshot FOLDS that history
      // into a snapshot event. The reconcile must not re-apply folded events
      // (that duplicates text), while still re-integrating genuinely-new ones.
      const doc = new Doc("client-A");
      const client = new CrdtClient(doc);

      // Server builds some text history and the client is fully synced.
      const serverDoc = new Doc("server-r");
      serverDoc.getMap().getText("t").insert(0, "Initial state. ");
      serverDoc.getMap().getText("t").insert(15, "Client 1 kept editing. ");

      const ws = new MockClientWebSocket();
      client.bind(ws);
      ws.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: serverDoc.egWalker.getStateSnapshot() }),
      });
      expect(doc.getMap().getText("t").toString()).toBe(
        "Initial state. Client 1 kept editing. ",
      );

      // Server compacts: fold everything into a snapshot event.
      const version = serverDoc.egWalker.graph.getLastCriticalVersion();
      const snapState = serverDoc.getSnapshot();
      const { snapshotEvent, remainingEvents } = serverDoc.egWalker.graph.compact(
        version,
        snapState as Record<string, unknown>,
        "server-r-snap",
        0,
      );
      const compactedDoc = new Doc("server-r2");
      compactedDoc.egWalker.integrateRemote([snapshotEvent, ...remainingEvents]);

      // The client receives the post-compaction snapshot.
      ws.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: compactedDoc.egWalker.getStateSnapshot() }),
      });

      // No duplication, and nothing stuck pending.
      expect(doc.getMap().getText("t").toString()).toBe(
        "Initial state. Client 1 kept editing. ",
      );
      expect(doc.egWalker.getPendingEventCount()).toBe(0);
      // Nothing was re-sent to the server either (all held events were folded).
      expect(ws.sentData.length).toBe(0);

      client.unbind();
    });

    it("does not echo foreign events back after loading a snapshot", () => {
      const doc = new Doc("client-B");
      const client = new CrdtClient(doc);

      const serverDoc = new Doc("server");
      serverDoc.getMap().set("k", "v");
      const snapshot = serverDoc.egWalker.getStateSnapshot();

      const ws = new MockClientWebSocket();
      client.bind(ws);
      ws.emit("message", {
        data: JSON.stringify({ type: "snapshot", data: snapshot }),
      });

      // The client had no local-only events, so nothing should be sent.
      expect(ws.sentData.length).toBe(0);

      client.unbind();
    });

    it("rebind switches sockets without throwing and moves listeners", () => {
      const doc = new Doc("client-C");
      const client = new CrdtClient(doc);

      const ws1 = new MockClientWebSocket();
      client.bind(ws1);
      expect(ws1.getListenerCount("message")).toBe(1);

      const ws2 = new MockClientWebSocket();
      expect(() => client.rebind(ws2)).not.toThrow();

      expect(ws1.getListenerCount("message")).toBe(0);
      expect(ws1.getListenerCount("open")).toBe(0);
      expect(ws2.getListenerCount("message")).toBe(1);

      client.unbind();
    });

    it("flushes queued offline edits when a bound socket opens", () => {
      const doc = new Doc("client-D");
      const client = new CrdtClient(doc);

      // Socket starts in CONNECTING state (not yet open).
      const ws = new MockClientWebSocket();
      ws.readyState = 0; // CONNECTING
      client.bind(ws);

      // Edit while the socket is still connecting: it must be queued, not sent.
      doc.getMap().set("queued", "1");
      expect(ws.sentData.length).toBe(0);

      // Socket opens: the queued edit is flushed.
      ws.readyState = 1; // OPEN
      ws.emit("open");

      const sends = ws.sentData
        .map((s) => JSON.parse(s))
        .filter((m) => m.type === "event" && m.data.op.key === "queued");
      expect(sends.length).toBe(1);

      client.unbind();
    });
  });

  describe("syncText", () => {
    it("should sync text to a YArray (character array) container", () => {
      const doc = new Doc("client-replica");
      const client = new CrdtClient(doc);

      // 1. Initial sync (inserts all characters)
      client.syncText(["content"], "hello", "array");
      const array = doc.getMap().getArray("content");
      expect(array.toJSON().join("")).toBe("hello");

      // 2. Sync with change (diff update: replaces 'o' with 'a')
      const versionBefore = doc.egWalker.getVersion();
      client.syncText(["content"], "hella", "array");
      expect(array.toJSON().join("")).toBe("hella");
      expect(doc.egWalker.getVersion()).not.toEqual(versionBefore);

      // 3. Sync with no changes
      const versionAfter = doc.egWalker.getVersion();
      client.syncText(["content"], "hella", "array");
      expect(doc.egWalker.getVersion()).toEqual(versionAfter);
    });

    it("should sync text to a YText container", () => {
      const doc = new Doc("client-replica");
      const client = new CrdtClient(doc);

      // 1. Initial sync (inserts text)
      client.syncText(["text-content"], "world", "text");
      const text = doc.getMap().getText("text-content");
      expect(text.toString()).toBe("world");

      // 2. Sync with change (replaces 'world' with 'word')
      const versionBefore = doc.egWalker.getVersion();
      client.syncText(["text-content"], "word", "text");
      expect(text.toString()).toBe("word");
      expect(doc.egWalker.getVersion()).not.toEqual(versionBefore);

      // 3. Sync with no changes
      const versionAfter = doc.egWalker.getVersion();
      client.syncText(["text-content"], "word", "text");
      expect(doc.egWalker.getVersion()).toEqual(versionAfter);
    });

    it("syncText never produces lone surrogates across emoji edits (B10)", () => {
      const cases: [string, string][] = [
        ["x👍y", "x👎y"],
        ["👍", "👍👎"],
        ["a😀b", "ab"],
        ["hello", "héllo"],
      ];
      for (const [oldT, newT] of cases) {
        const doc = new Doc("r");
        const client = new CrdtClient(doc);
        client.syncText(["t"], oldT, "text");
        client.syncText(["t"], newT, "text");
        const got = doc.getMap().getText("t").toString();
        expect(got).toBe(newT);
        expect(got.isWellFormed()).toBe(true);
      }
    });
  });
});
