import { describe, it, expect, vi } from 'vitest';
import { CrdtServer } from "../crdtServer.js";

type EventListener = (data: unknown) => void;

// Mock minimal websocket
class MockWebSocket {
  public readyState = 1;
  private listeners: Record<string, EventListener[]> = {};
  public sendMock = vi.fn();

  on(event: string, cb: EventListener) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }

  addEventListener(event: string, cb: EventListener) {
    this.on(event, cb);
  }

  send(data: string) {
    this.sendMock(data);
  }

  trigger(event: string, data?: unknown) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(data));
    }
  }
}

describe("Awareness Protocol", () => {
  it("should broadcast awareness to other clients and remove on disconnect", async () => {
    const mockRepo = {
      getEvents: vi.fn().mockResolvedValue([]),
      saveEvents: vi.fn().mockResolvedValue(undefined),
    };

    const server = new CrdtServer("test-room", mockRepo);

    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    await server.handleConnection(ws1);
    await server.handleConnection(ws2);

    // Client 1 sends awareness
    const awarenessMsg = {
      type: "awareness",
      data: { replicaId: "rep1", state: { cursor: 5 } }
    };
    ws1.trigger("message", JSON.stringify(awarenessMsg));

    // Wait a tick for promises
    await new Promise((r) => setTimeout(r, 10));

    // Server should have broadcast to ws2, but not ws1
    expect(ws2.sendMock).toHaveBeenCalledWith(JSON.stringify(awarenessMsg));
    
    // Check server state
    expect(server.getDoc().egWalker.getAwareness("rep1")).toEqual({ cursor: 5 });

    // Client 1 disconnects
    ws2.sendMock.mockClear();
    ws1.trigger("close");

    await new Promise((r) => setTimeout(r, 10));

    // Server should have broadcast null state to ws2
    expect(ws2.sendMock).toHaveBeenCalledWith(JSON.stringify({
      type: "awareness",
      data: { replicaId: "rep1", state: null }
    }));
    
    // Server should have cleared it locally
    expect(server.getDoc().egWalker.getAwareness("rep1")).toBeUndefined();
  });
});
