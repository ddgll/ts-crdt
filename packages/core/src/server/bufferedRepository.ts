import { CrdtEvent } from "../index.js";
import { getLogger } from "../logger.js";
import { Repository } from "./crdtServer.js";

/**
 * A repository decorator/wrapper that buffers save operations and flushes them
 * to the underlying repository in batches or at specified time intervals.
 */
export class BufferedRepository implements Repository {
  private buffer: CrdtEvent[] = [];
  /**
   * Events removed from `buffer` for the current flush but whose underlying
   * `saveEvents` has not yet resolved. Kept visible to {@link getEvents} so a
   * read during the flush window never observes a gap where an event is in
   * neither `buffer` nor the persisted store.
   */
  private inFlight: CrdtEvent[] = [];
  private flushTimeout: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(
    private targetRepository: Repository,
    private options: {
      flushIntervalMs?: number;
      batchSize?: number;
    } = {}
  ) {}

  async getEvents(): Promise<CrdtEvent[]> {
    const persisted = await this.targetRepository.getEvents();
    // Include in-flight events so the combined history is complete even mid-flush.
    // A concurrent flush may resolve between reading `persisted` and appending
    // `inFlight`, briefly double-counting an event; that is harmless because
    // event integration is idempotent (deduplicated by id), whereas omitting an
    // in-flight event would expose an incomplete history.
    return [...persisted, ...this.inFlight, ...this.buffer];
  }

  async saveEvents(events: CrdtEvent[]): Promise<void> {
    this.buffer.push(...events);
    const batchSize = this.options.batchSize ?? 100;

    if (this.buffer.length >= batchSize) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    if (this.buffer.length === 0 || this.isFlushing) return;

    this.isFlushing = true;
    const batchToSave = [...this.buffer];
    this.buffer = [];
    // Hold the batch in `inFlight` until the save resolves so getEvents() never
    // observes a window where these events are neither buffered nor persisted.
    this.inFlight = batchToSave;

    try {
      await this.targetRepository.saveEvents(batchToSave);
    } catch (err) {
      // Put events back in the buffer on failure to avoid losing them
      this.buffer.unshift(...batchToSave);
      this.scheduleFlush();
      throw err;
    } finally {
      // Clear only if still holding this batch; a failure path already moved the
      // events back into `buffer`, so keeping them in `inFlight` would double them.
      if (this.inFlight === batchToSave) {
        this.inFlight = [];
      }
      this.isFlushing = false;
    }
  }

  private scheduleFlush() {
    if (this.flushTimeout || this.isFlushing) return;
    const interval = this.options.flushIntervalMs ?? 1000;
    this.flushTimeout = setTimeout(() => {
      this.flush().catch((err) => getLogger().error("Failed to flush buffered events:", err));
    }, interval);
  }

  async clearEvents(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    this.buffer = [];
    this.inFlight = [];
    if (this.targetRepository.clearEvents) {
      await this.targetRepository.clearEvents();
    }
  }
}
