import { describe, it, expect, vi } from "vitest";
import { BufferedRepository } from "../bufferedRepository.js";
import { Repository } from "../crdtServer.js";
import { CrdtEvent } from "../../index.js";

class MockRepository implements Repository {
  events: CrdtEvent[] = [];
  saveEventsCalls = 0;
  shouldFail = false;

  async getEvents(): Promise<CrdtEvent[]> {
    return this.events;
  }

  async saveEvents(events: CrdtEvent[]): Promise<void> {
    if (this.shouldFail) {
      throw new Error("Simulated database write error");
    }
    this.saveEventsCalls++;
    this.events.push(...events);
  }

  async clearEvents(): Promise<void> {
    this.events = [];
    this.saveEventsCalls = 0;
  }
}

describe("BufferedRepository", () => {
  it("should buffer events and flush when batchSize is met", async () => {
    const repo = new MockRepository();
    const bufferedRepo = new BufferedRepository(repo, { batchSize: 3, flushIntervalMs: 10000 });

    const e1 = { id: "1", replicaId: "A", parents: [], op: { type: "array-insert", path: [], index: 0, values: [] } } as unknown as CrdtEvent;
    const e2 = { id: "2", replicaId: "A", parents: [], op: { type: "array-insert", path: [], index: 1, values: [] } } as unknown as CrdtEvent;
    const e3 = { id: "3", replicaId: "A", parents: [], op: { type: "array-insert", path: [], index: 2, values: [] } } as unknown as CrdtEvent;

    await bufferedRepo.saveEvents([e1]);
    await bufferedRepo.saveEvents([e2]);
    expect(repo.events.length).toBe(0); // Not flushed yet

    await bufferedRepo.saveEvents([e3]);
    expect(repo.events.length).toBe(3); // Flushed immediately because batchSize of 3 was reached
    expect(repo.saveEventsCalls).toBe(1);
  });

  it("should flush periodically on scheduled interval", async () => {
    vi.useFakeTimers();
    const repo = new MockRepository();
    const bufferedRepo = new BufferedRepository(repo, { batchSize: 10, flushIntervalMs: 100 });

    const e1 = { id: "1", replicaId: "A", parents: [], op: { type: "array-insert", path: [], index: 0, values: [] } } as unknown as CrdtEvent;
    await bufferedRepo.saveEvents([e1]);

    expect(repo.events.length).toBe(0); // Not flushed yet

    // Fast forward time
    vi.advanceTimersByTime(150);

    expect(repo.events.length).toBe(1);
    expect(repo.saveEventsCalls).toBe(1);
    vi.useRealTimers();
  });

  it("should recover and keep events in buffer on flush failure", async () => {
    const repo = new MockRepository();
    const bufferedRepo = new BufferedRepository(repo, { batchSize: 2, flushIntervalMs: 10000 });

    const e1 = { id: "1", replicaId: "A", parents: [], op: { type: "array-insert", path: [], index: 0, values: [] } } as unknown as CrdtEvent;
    const e2 = { id: "2", replicaId: "A", parents: [], op: { type: "array-insert", path: [], index: 1, values: [] } } as unknown as CrdtEvent;

    repo.shouldFail = true;

    // This should trigger a flush which fails
    await expect(bufferedRepo.saveEvents([e1, e2])).rejects.toThrow();

    expect(repo.events.length).toBe(0); // DB remains empty

    // Disable failure, manually flush
    repo.shouldFail = false;
    await bufferedRepo.flush();

    expect(repo.events.length).toBe(2); // Successfully saved
    expect(repo.saveEventsCalls).toBe(1);
  });
});
