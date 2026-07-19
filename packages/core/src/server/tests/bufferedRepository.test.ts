import { describe, it, expect, vi } from 'vitest';
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

  it("drains events that arrive during an in-flight flush (B7)", async () => {
    // A repository whose first save blocks until released, so we can inject a new
    // event into the buffer while a flush is in flight.
    class GatedRepository implements Repository {
      events: CrdtEvent[] = [];
      private gates: (() => void)[] = [];
      blocking = false;
      async getEvents(): Promise<CrdtEvent[]> {
        return this.events;
      }
      async saveEvents(events: CrdtEvent[]): Promise<void> {
        if (this.blocking) {
          await new Promise<void>((resolve) => this.gates.push(resolve));
        }
        this.events.push(...events);
      }
      release(): void {
        this.blocking = false;
        const g = [...this.gates];
        this.gates = [];
        g.forEach((r) => r());
      }
    }

    const repo = new GatedRepository();
    repo.blocking = true;
    const buffered = new BufferedRepository(repo, { batchSize: 1, flushIntervalMs: 100000 });

    const e1 = { id: "1", replicaId: "A", parents: [], op: { type: "array-insert", path: [], afterId: null, values: [] } } as unknown as CrdtEvent;
    const e2 = { id: "2", replicaId: "A", parents: [], op: { type: "array-insert", path: [], afterId: null, values: [] } } as unknown as CrdtEvent;

    // e1 fills the batch and starts a drain that blocks inside saveEvents.
    const p1 = buffered.saveEvents([e1]);
    await Promise.resolve();
    // e2 arrives while the first save is still in flight.
    const p2 = buffered.saveEvents([e2]);

    expect(repo.events.length).toBe(0); // nothing persisted while gated

    repo.release();
    await Promise.all([p1, p2]);
    // A final flush must find nothing left — everything is already durable.
    await buffered.flush();

    expect(repo.events.map((e) => e.id).sort()).toEqual(["1", "2"]);
    // getEvents must never report an event as neither buffered nor persisted.
    const all = await buffered.getEvents();
    expect(all.map((e) => e.id).sort()).toEqual(["1", "2"]);
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
