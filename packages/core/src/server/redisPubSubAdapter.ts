import { CrdtEvent, ServerMessage } from "../index.js";
import { PubSubAdapter } from "./pubSubAdapter.js";

/**
 * A PubSubAdapter implementation using the standard 'redis' (node-redis v4+) client.
 */
export class NodeRedisPubSubAdapter implements PubSubAdapter {
  constructor(
    private pubClient: {
      publish(channel: string, message: string): Promise<unknown> | unknown;
    },
    private subClient: {
      subscribe(channel: string, listener: (message: string) => void): Promise<unknown> | unknown;
      unsubscribe(channel: string): Promise<unknown> | unknown;
    }
  ) {}

  async publish(roomId: string, message: ServerMessage): Promise<void> {
    const channel = `room:${roomId}`;
    await this.pubClient.publish(channel, JSON.stringify(message));
  }

  async subscribe(roomId: string, onMessage: (message: ServerMessage) => void): Promise<() => void> {
    const channel = `room:${roomId}`;
    
    const listener = (message: string) => {
      try {
        onMessage(JSON.parse(message));
      } catch (err) {
        console.error("Failed to parse Redis event from channel:", channel, err);
      }
    };

    await this.subClient.subscribe(channel, listener);

    return async () => {
      await this.subClient.unsubscribe(channel);
    };
  }
}

export type IoRedisOnMessageListener = (channel: string, message: string) => void;

/**
 * A PubSubAdapter implementation using the 'ioredis' client.
 */
export class IoRedisPubSubAdapter implements PubSubAdapter {
  constructor(
    private pubClient: {
      publish(channel: string, message: string): Promise<unknown> | unknown;
    },
    private subClient: {
      subscribe(channel: string): Promise<unknown> | unknown;
      unsubscribe(channel: string): Promise<unknown> | unknown;
      on(event: "message", listener: IoRedisOnMessageListener): unknown;
      off(event: "message", listener: IoRedisOnMessageListener): unknown;
    }
  ) {}

  async publish(roomId: string, message: ServerMessage): Promise<void> {
    const channel = `room:${roomId}`;
    await this.pubClient.publish(channel, JSON.stringify(message));
  }

  async subscribe(roomId: string, onMessage: (message: ServerMessage) => void): Promise<() => void> {
    const channel = `room:${roomId}`;
    
    const listener: IoRedisOnMessageListener = (chan, msg) => {
      if (chan === channel) {
        try {
          onMessage(JSON.parse(msg));
        } catch (err) {
          console.error("Failed to parse Redis event from channel:", chan, err);
        }
      }
    };

    this.subClient.on("message", listener);
    await this.subClient.subscribe(channel);

    return async () => {
      this.subClient.off("message", listener);
      await this.subClient.unsubscribe(channel);
    };
  }
}
