import PQueue from "p-queue";

export interface Limits {
  /** Most requests started in any rolling minute. */
  rpm?: number;
  /** Most requests in flight at once. */
  concurrency?: number;
}

export class QueueTimeoutError extends Error {
  override name = "QueueTimeoutError";
}

/**
 * Outbound limits per provider, so the gateway holds back what a provider
 * would reject instead of sending it and retrying. Requests over a limit wait
 * in a FIFO queue. State is in memory, so limits apply per gateway process.
 */
export class ProviderLimiter {
  readonly #queues = new Map<string, PQueue>();

  constructor(limits: Record<string, Limits | undefined>, intervalMs = 60_000) {
    for (const [provider, limit] of Object.entries(limits)) {
      if (!limit || (limit.rpm === undefined && limit.concurrency === undefined)) continue;
      this.#queues.set(
        provider,
        new PQueue({
          concurrency: limit.concurrency ?? Infinity,
          ...(limit.rpm === undefined
            ? {}
            : { intervalCap: limit.rpm, interval: intervalMs, strict: true }),
        }),
      );
    }
  }

  /** Requests waiting for a slot. */
  depth(provider: string): number {
    return this.#queues.get(provider)?.size ?? 0;
  }

  /**
   * Run `task` once the provider has a free slot; the task is told how long it
   * waited. Rejects with QueueTimeoutError, without running the task, when no
   * slot frees up within `maxQueueMs`.
   */
  async run<T>(provider: string, maxQueueMs: number, task: (queuedMs: number) => Promise<T>) {
    const queue = this.#queues.get(provider);
    if (!queue) return task(0);

    const enqueued = performance.now();
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), maxQueueMs);
    let started = false;
    try {
      return await queue.add(
        () => {
          started = true;
          clearTimeout(timer);
          return task(performance.now() - enqueued);
        },
        { signal: giveUp.signal },
      );
    } catch (error) {
      if (started) throw error;
      throw new QueueTimeoutError(
        `no free slot for '${provider}' within ${maxQueueMs} ms (${queue.size} requests waiting)`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
