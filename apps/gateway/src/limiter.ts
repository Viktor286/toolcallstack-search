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

/** Holds a call back until its provider has a free slot. */
export interface Limiter {
  /** Requests waiting for a slot. */
  depth(provider: string): number;
  /**
   * Run `task` once the provider has a free slot; the task is told how long it
   * waited. Rejects with QueueTimeoutError, without running the task, when no
   * slot frees up within `maxQueueMs`.
   */
  run<T>(provider: string, maxQueueMs: number, task: (queuedMs: number) => Promise<T>): Promise<T>;
}

/**
 * Outbound limits per provider, so the gateway holds back what a provider
 * would reject instead of sending it and retrying. Requests over a limit wait
 * in a FIFO queue. State is in memory, so limits apply per gateway process;
 * PostgresLimiter shares them between processes.
 */
export class ProviderLimiter implements Limiter {
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

  depth(provider: string): number {
    return this.#queues.get(provider)?.size ?? 0;
  }

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
