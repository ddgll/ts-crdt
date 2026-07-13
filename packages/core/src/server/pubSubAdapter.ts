import { ServerMessage } from "../index.js";

/**
 * Interface representing a publish/subscribe adapter to replicate events across instances.
 */
export interface PubSubAdapter {
  /**
   * Publishes an event to a specific channel/room.
   */
  publish(roomId: string, message: ServerMessage): Promise<void>;

  /**
   * Subscribes to events for a specific channel/room.
   * Returns a promise that resolves to an unsubscribe function.
   */
  subscribe(roomId: string, onMessage: (message: ServerMessage) => void): Promise<() => void>;
}

/**
 * A basic in-memory PubSub implementation.
 * Extremely useful for testing and local multi-replica scenarios on a single server process.
 */
export class InMemoryPubSubAdapter implements PubSubAdapter {
  private listeners = new Map<string, Set<(message: ServerMessage) => void>>();

  async publish(roomId: string, message: ServerMessage): Promise<void> {
    const roomListeners = this.listeners.get(roomId);
    if (roomListeners) {
      // Snapshot the listener set so that subscribe/unsubscribe calls triggered
      // during dispatch cannot mutate the collection being iterated, and so a
      // set that empties (and is dropped from `this.listeners`) before the
      // microtask runs still delivers to the listeners present at publish time.
      const listeners = [...roomListeners];
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener(message);
        }
      });
    }
  }

  async subscribe(roomId: string, onMessage: (message: ServerMessage) => void): Promise<() => void> {
    if (!this.listeners.has(roomId)) {
      this.listeners.set(roomId, new Set());
    }
    this.listeners.get(roomId)!.add(onMessage);

    return () => {
      const roomListeners = this.listeners.get(roomId);
      if (roomListeners) {
        roomListeners.delete(onMessage);
        if (roomListeners.size === 0) {
          this.listeners.delete(roomId);
        }
      }
    };
  }
}
