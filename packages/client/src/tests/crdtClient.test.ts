import { describe, it, expect } from "vitest";
import { Doc, CrdtEvent } from "@ddgll/ts-crdt";
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
    expect(parsed.op.type).toBe("map-set");
    expect(parsed.op.key).toBe("hello");
    expect(parsed.op.value).toBe("world");

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
});
