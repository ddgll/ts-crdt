import { describe, it, expect, vi } from 'vitest';
import { handleWebSocket, serverInstances } from "../crdtServer.js";
import { MinimalWebSocket } from "../crdtServer.js";

describe("serverInstances lifecycle", () => {
    it("should remove server from global map after all clients disconnect and timeout passes", async () => {
        vi.useFakeTimers();

        const roomId = "test-room-lifecycle";
        const mockRepo = {
            getEvents: async () => [],
            saveEvents: async () => {}
        };
        
        let closeCb: (() => void) | undefined;
        const mockSocket = {
            readyState: 1,
            on: (event: string, cb: (...args: unknown[]) => void) => {
                if (event === "close") closeCb = cb as () => void;
            },
            send: vi.fn(),
        } as unknown as MinimalWebSocket;

        await handleWebSocket(mockSocket, roomId, mockRepo, { idleTimeoutMs: 1000 });
        
        expect(serverInstances.has(roomId)).toBe(true);

        // Disconnect
        if (closeCb) closeCb();
        
        // Timeout hasn't passed yet
        expect(serverInstances.has(roomId)).toBe(true);

        vi.advanceTimersByTime(1500);

        // Should be removed
        expect(serverInstances.has(roomId)).toBe(false);

        vi.useRealTimers();
    });

    it("should create a new server instance on reconnection after cleanup", async () => {
        vi.useFakeTimers();

        const roomId = "test-room-lifecycle-2";
        const mockRepo = {
            getEvents: async () => [],
            saveEvents: async () => {}
        };
        
        let closeCb: (() => void) | undefined;
        const mockSocket1 = {
            readyState: 1,
            on: (event: string, cb: (...args: unknown[]) => void) => {
                if (event === "close") closeCb = cb as () => void;
            },
            send: vi.fn(),
        } as unknown as MinimalWebSocket;

        await handleWebSocket(mockSocket1, roomId, mockRepo, { idleTimeoutMs: 1000 });
        const server1 = serverInstances.get(roomId);
        
        if (closeCb) closeCb();
        vi.advanceTimersByTime(1500);
        expect(serverInstances.has(roomId)).toBe(false);

        const mockSocket2 = {
            readyState: 1,
            on: vi.fn(),
            send: vi.fn(),
        } as unknown as MinimalWebSocket;

        await handleWebSocket(mockSocket2, roomId, mockRepo, { idleTimeoutMs: 1000 });
        const server2 = serverInstances.get(roomId);

        expect(server2).toBeDefined();
        expect(server1).not.toBe(server2);

        vi.useRealTimers();
    });
});
