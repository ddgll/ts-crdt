import { CrdtEvent } from "../index.js";
import { Repository } from "./crdtServer.js";

/**
 * A repository decorator/wrapper that buffers save operations and flushes them
 * to the underlying repository in batches or at specified time intervals.
 */
export class BufferedRepository implements Repository {
  private buffer: CrdtEvent[] = [];
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
    return [...persisted, ...this.buffer];
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

    try {
      await this.targetRepository.saveEvents(batchToSave);
    } catch (err) {
      // Put events back in the buffer on failure to avoid losing them
      this.buffer.unshift(...batchToSave);
      this.scheduleFlush();
      throw err;
    } finally {
      this.isFlushing = false;
    }
  }

  private scheduleFlush() {
    if (this.flushTimeout || this.isFlushing) return;
    const interval = this.options.flushIntervalMs ?? 1000;
    this.flushTimeout = setTimeout(() => {
      this.flush().catch((err) => console.error("Failed to flush buffered events:", err));
    }, interval);
  }

  async clearEvents(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    this.buffer = [];
    if (this.targetRepository.clearEvents) {
      await this.targetRepository.clearEvents();
    }
  }
}
