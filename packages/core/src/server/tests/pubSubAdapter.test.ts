import { describe, it, expect, vi } from 'vitest';
import { InMemoryPubSubAdapter } from "../pubSubAdapter.js";
import { NodeRedisPubSubAdapter, IoRedisPubSubAdapter, IoRedisOnMessageListener } from "../redisPubSubAdapter.js";
import { CrdtEvent } from "../../index.js";

const dummyEvent1 = { id: "1:1", replicaId: "1", parents: [], op: { type: "array-insert", path: ["content"], index: 0, values: ["a"] } } as unknown as CrdtEvent;
const dummyEvent2 = { id: "2:1", replicaId: "2", parents: [], op: { type: "array-insert", path: ["content"], index: 1, values: ["b"] } } as unknown as CrdtEvent;

describe("InMemoryPubSubAdapter", () => {
  it("should broadcast events to all subscribers in the same room", async () => {
    const pubSub = new InMemoryPubSubAdapter();
    const receivedEvents1: CrdtEvent[] = [];
    const receivedEvents2: CrdtEvent[] = [];

    const unsub1 = await pubSub.subscribe("room-1", (evt) => receivedEvents1.push(evt));
    const unsub2 = await pubSub.subscribe("room-1", (evt) => receivedEvents2.push(evt));

    await pubSub.publish("room-1", dummyEvent1);

    // Wait a tick for microtask queue
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedEvents1).toEqual([dummyEvent1]);
    expect(receivedEvents2).toEqual([dummyEvent1]);

    unsub1();
    unsub2();
  });

  it("should isolate events by roomId", async () => {
    const pubSub = new InMemoryPubSubAdapter();
    const receivedEventsRoom1: CrdtEvent[] = [];
    const receivedEventsRoom2: CrdtEvent[] = [];

    const unsub1 = await pubSub.subscribe("room-1", (evt) => receivedEventsRoom1.push(evt));
    const unsub2 = await pubSub.subscribe("room-2", (evt) => receivedEventsRoom2.push(evt));

    await pubSub.publish("room-1", dummyEvent1);
    await pubSub.publish("room-2", dummyEvent2);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedEventsRoom1).toEqual([dummyEvent1]);
    expect(receivedEventsRoom2).toEqual([dummyEvent2]);

    unsub1();
    unsub2();
  });

  it("should stop receiving events after unsubscribing", async () => {
    const pubSub = new InMemoryPubSubAdapter();
    const received: CrdtEvent[] = [];

    const unsub = await pubSub.subscribe("room-1", (evt) => received.push(evt));

    await pubSub.publish("room-1", dummyEvent1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([dummyEvent1]);

    unsub();

    await pubSub.publish("room-1", dummyEvent2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([dummyEvent1]); // Still only has the first event
  });

  it("should not throw or skip deliveries when a listener unsubscribes another mid-dispatch", async () => {
    const pubSub = new InMemoryPubSubAdapter();
    const receivedA: CrdtEvent[] = [];
    const receivedB: CrdtEvent[] = [];
    const receivedC: CrdtEvent[] = [];

    // Listener A unsubscribes both B and C during dispatch. Because publish
    // snapshots the listener set, every listener present at publish time must
    // still receive the message and the iteration must not throw.
    let unsubB: () => void = () => {};
    let unsubC: () => void = () => {};

    const unsubA = await pubSub.subscribe("room-1", (evt) => {
      receivedA.push(evt);
      unsubB();
      unsubC();
    });
    unsubB = await pubSub.subscribe("room-1", (evt) => receivedB.push(evt));
    unsubC = await pubSub.subscribe("room-1", (evt) => receivedC.push(evt));

    await expect(pubSub.publish("room-1", dummyEvent1)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // All three listeners captured at publish time received the event.
    expect(receivedA).toEqual([dummyEvent1]);
    expect(receivedB).toEqual([dummyEvent1]);
    expect(receivedC).toEqual([dummyEvent1]);

    // The unsubscribes took effect for subsequent publishes.
    await pubSub.publish("room-1", dummyEvent2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receivedA).toEqual([dummyEvent1, dummyEvent2]);
    expect(receivedB).toEqual([dummyEvent1]);
    expect(receivedC).toEqual([dummyEvent1]);

    unsubA();
  });
});

describe("NodeRedisPubSubAdapter", () => {
  it("should publish correctly to Redis", async () => {
    const mockPubClient = {
      publish: vi.fn().mockResolvedValue(1),
    };
    const mockSubClient = {
      subscribe: vi.fn().mockResolvedValue("OK"),
      unsubscribe: vi.fn().mockResolvedValue("OK"),
    };

    const adapter = new NodeRedisPubSubAdapter(mockPubClient, mockSubClient);
    await adapter.publish("my-room", dummyEvent1);

    expect(mockPubClient.publish).toHaveBeenCalledWith("room:my-room", JSON.stringify(dummyEvent1));
  });

  it("should subscribe and unsubscribe correctly with node-redis callback style", async () => {
    const mockPubClient = {
      publish: vi.fn(),
    };

    let registeredCallback: ((message: string) => void) | undefined;
    const mockSubClient = {
      subscribe: vi.fn().mockImplementation(async (channel: string, cb: (message: string) => void) => {
        registeredCallback = cb;
        return "OK";
      }),
      unsubscribe: vi.fn().mockResolvedValue("OK"),
    };

    const adapter = new NodeRedisPubSubAdapter(mockPubClient, mockSubClient);
    const received: CrdtEvent[] = [];

    const unsub = await adapter.subscribe("my-room", (evt) => received.push(evt));

    expect(mockSubClient.subscribe).toHaveBeenCalledWith("room:my-room", expect.any(Function));
    expect(registeredCallback).toBeDefined();

    // Trigger mock event message
    registeredCallback!(JSON.stringify(dummyEvent1));
    expect(received).toEqual([dummyEvent1]);

    // Clean up
    await unsub();
    expect(mockSubClient.unsubscribe).toHaveBeenCalledWith("room:my-room");
  });
});

describe("IoRedisPubSubAdapter", () => {
  it("should publish correctly to Redis", async () => {
    const mockPubClient = {
      publish: vi.fn().mockResolvedValue(1),
    };
    const mockSubClient = {
      subscribe: vi.fn().mockResolvedValue("OK"),
      unsubscribe: vi.fn().mockResolvedValue("OK"),
      on: vi.fn(),
      off: vi.fn(),
    };

    const adapter = new IoRedisPubSubAdapter(mockPubClient, mockSubClient);
    await adapter.publish("my-room", dummyEvent1);

    expect(mockPubClient.publish).toHaveBeenCalledWith("room:my-room", JSON.stringify(dummyEvent1));
  });

  it("should subscribe and unsubscribe correctly with ioredis event emitter style", async () => {
    const mockPubClient = {
      publish: vi.fn(),
    };
    
    // Simulate event emitter for ioredis
    const listeners: Record<string, IoRedisOnMessageListener[]> = {};
    const mockSubClient = {
      subscribe: vi.fn().mockResolvedValue("OK"),
      unsubscribe: vi.fn().mockResolvedValue("OK"),
      on: vi.fn((event: string, cb: IoRedisOnMessageListener) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
      }),
      off: vi.fn((event: string, cb: IoRedisOnMessageListener) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((fn) => fn !== cb);
        }
      }),
    };

    const adapter = new IoRedisPubSubAdapter(mockPubClient, mockSubClient);
    const received: CrdtEvent[] = [];

    const unsub = await adapter.subscribe("my-room", (evt) => received.push(evt));

    expect(mockSubClient.subscribe).toHaveBeenCalledWith("room:my-room");
    expect(mockSubClient.on).toHaveBeenCalledWith("message", expect.any(Function));

    // Simulate Redis message event
    const messageListener = listeners["message"]?.[0];
    expect(messageListener).toBeDefined();

    // Send correct channel and message
    messageListener("room:my-room", JSON.stringify(dummyEvent1));
    expect(received).toEqual([dummyEvent1]);

    // Send mismatching channel
    messageListener("room:other-room", JSON.stringify(dummyEvent2));
    expect(received).toEqual([dummyEvent1]); // No change

    // Clean up
    await unsub();
    expect(mockSubClient.unsubscribe).toHaveBeenCalledWith("room:my-room");
    expect(mockSubClient.off).toHaveBeenCalledWith("message", messageListener);
  });
});
