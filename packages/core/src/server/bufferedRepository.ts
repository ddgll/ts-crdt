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
  /**
   * The currently-running drain, or null when idle. Concurrent {@link flush}
   * callers await this instead of starting a competing drain, and it lets a
   * caller detect that it must start a fresh drain when the buffer refilled after
   * the previous drain finished.
   */
  private flushingPromise: Promise<void> | null = null;
  /**
   * Bumped by {@link clearEvents}. A batch captures the epoch when its save
   * starts; if the save later fails but the epoch has since changed (a
   * compaction cleared the store in between), the batch is NOT returned to the
   * buffer — those events belong to superseded history and must not be
   * resurrected on top of the new snapshot.
   */
  private epoch = 0;

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

    // Join an in-progress drain rather than no-op'ing. A previous version
    // returned immediately while a flush was in flight, stranding events that
    // filled the buffer during the save and making the shutdown flush claim
    // durability it had not achieved. Loop so we also start a fresh drain when
    // the buffer refilled after the joined drain completed.
    while (this.flushingPromise) {
      const inProgress = this.flushingPromise;
      await inProgress;
      if (this.flushingPromise === inProgress) {
        // The drain we awaited is finished and nobody else took over.
        this.flushingPromise = null;
        break;
      }
    }

    if (this.buffer.length === 0) return;

    this.flushingPromise = this.drain();
    try {
      await this.flushingPromise;
    } catch (err) {
      // Retry later; the failing batch has already been returned to the buffer.
      this.scheduleFlush();
      throw err;
    } finally {
      this.flushingPromise = null;
    }
  }

  /**
   * Persists batches until the buffer is empty, so a resolved drain guarantees
   * everything buffered at completion time has been saved.
   */
  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batchToSave = [...this.buffer];
      const batchEpoch = this.epoch;
      this.buffer = [];
      // Hold the batch in `inFlight` until the save resolves so getEvents() never
      // observes a window where these events are neither buffered nor persisted.
      this.inFlight = batchToSave;
      try {
        await this.targetRepository.saveEvents(batchToSave);
      } catch (err) {
        // Put events back in the buffer on failure to avoid losing them — unless
        // a clearEvents() (e.g. compaction) ran in the meantime, in which case
        // these events are superseded history and must not be resurrected.
        if (this.epoch === batchEpoch) {
          this.buffer.unshift(...batchToSave);
        }
        throw err;
      } finally {
        // Clear only if still holding this batch; a failure path already moved the
        // events back into `buffer`, so keeping them in `inFlight` would double them.
        if (this.inFlight === batchToSave) {
          this.inFlight = [];
        }
      }
    }
  }

  private scheduleFlush() {
    if (this.flushTimeout || this.flushingPromise) return;
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
    // Invalidate any in-flight batch's epoch so a concurrent failed save cannot
    // re-buffer events that this clear is removing.
    this.epoch++;
    this.buffer = [];
    this.inFlight = [];
    if (this.targetRepository.clearEvents) {
      await this.targetRepository.clearEvents();
    }
  }
}
