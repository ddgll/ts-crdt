import { CrdtEvent } from "../index.js";

/**
 * Interface representing a publish/subscribe adapter to replicate events across instances.
 */
export interface PubSubAdapter {
  /**
   * Publishes an event to a specific channel/room.
   */
  publish(roomId: string, event: CrdtEvent): Promise<void>;

  /**
   * Subscribes to events for a specific channel/room.
   * Returns a promise that resolves to an unsubscribe function.
   */
  subscribe(roomId: string, onEvent: (event: CrdtEvent) => void): Promise<() => void>;
}

/**
 * A basic in-memory PubSub implementation.
 * Extremely useful for testing and local multi-replica scenarios on a single server process.
 */
export class InMemoryPubSubAdapter implements PubSubAdapter {
  private listeners = new Map<string, Set<(event: CrdtEvent) => void>>();

  async publish(roomId: string, event: CrdtEvent): Promise<void> {
    const roomListeners = this.listeners.get(roomId);
    if (roomListeners) {
      queueMicrotask(() => {
        for (const listener of roomListeners) {
          listener(event);
        }
      });
    }
  }

  async subscribe(roomId: string, onEvent: (event: CrdtEvent) => void): Promise<() => void> {
    if (!this.listeners.has(roomId)) {
      this.listeners.set(roomId, new Set());
    }
    this.listeners.get(roomId)!.add(onEvent);

    return () => {
      const roomListeners = this.listeners.get(roomId);
      if (roomListeners) {
        roomListeners.delete(onEvent);
        if (roomListeners.size === 0) {
          this.listeners.delete(roomId);
        }
      }
    };
  }
}
