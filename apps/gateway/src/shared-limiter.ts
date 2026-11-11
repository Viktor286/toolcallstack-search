import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ProviderLimiter, QueueTimeoutError, type Limiter, type Limits } from "./limiter.ts";

// A slot whose holder never released it (a crashed instance) stops counting after this long.
const STALE_SECONDS = 300;
// How often a call waiting for a concurrency slot looks again.
const POLL_MS = 50;

/** A slot taken, or how long to wait before asking again. */
type Acquired = { id: string } | { retryMs: number };

/**
 * The same outbound limits as ProviderLimiter, but counted in Postgres so that
 * several gateway instances share one budget of requests per provider. Each
 * upstream request takes a row; the count of recent rows is the rolling
 * window, the count of unreleased rows is the concurrency. Waiting calls poll,
 * so the order between instances is not strictly first-come. While Postgres
 * cannot be reached, calls fall back to this instance's own in-memory limits.
 */
export class PostgresLimiter implements Limiter {
  readonly #sql: postgres.Sql;
  readonly #limits: Record<string, Limits | undefined>;
  readonly #windowSeconds: number;
  readonly #instance = randomUUID();
  readonly #waiting = new Map<string, number>();
  readonly #fallback: ProviderLimiter;
  readonly #onError: (error: unknown) => void;

  constructor(
    sql: postgres.Sql,
    limits: Record<string, Limits | undefined>,
    windowMs = 60_000,
    /** Told when Postgres fails and a call falls back to the in-memory limits. */
    onError: (error: unknown) => void = () => {},
  ) {
    this.#sql = sql;
    this.#limits = limits;
    this.#windowSeconds = windowMs / 1000;
    this.#fallback = new ProviderLimiter(limits, windowMs);
    this.#onError = onError;
  }

  /** Requests of this instance waiting for a slot. */
  depth(provider: string): number {
    return (this.#waiting.get(provider) ?? 0) + this.#fallback.depth(provider);
  }

  /** Take a slot if the limits allow; otherwise say how long to wait before asking again. */
  async #acquire(provider: string, limit: Limits): Promise<Acquired> {
    return this.#sql.begin(async (tx) => {
      // One decision at a time per provider, across all instances.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`limiter:${provider}`}))`;
      await tx`
        DELETE FROM gateway.limiter_slots
        WHERE provider = ${provider}
          AND acquired_at < now() - make_interval(secs => ${Math.max(this.#windowSeconds, STALE_SECONDS)})`;
      const [row] = await tx<{ recent: number; running: number; free_in_ms: number | null }[]>`
        SELECT
          count(*) FILTER (WHERE recent)::int AS recent,
          count(*) FILTER (
            WHERE released_at IS NULL AND acquired_at > now() - make_interval(secs => ${STALE_SECONDS})
          )::int AS running,
          (extract(epoch FROM min(acquired_at) FILTER (WHERE recent) - now()) + ${this.#windowSeconds}::float8)
            * 1000 AS free_in_ms
        FROM (
          SELECT *, acquired_at > now() - make_interval(secs => ${this.#windowSeconds}) AS recent
          FROM gateway.limiter_slots
          WHERE provider = ${provider}
        ) slots`;
      const windowFull = limit.rpm !== undefined && row!.recent >= limit.rpm;
      const busy = limit.concurrency !== undefined && row!.running >= limit.concurrency;
      if (windowFull) return { retryMs: Math.max(POLL_MS, Math.ceil(row!.free_in_ms ?? 0)) };
      if (busy) return { retryMs: POLL_MS };
      const [slot] = await tx<{ id: string }[]>`
        INSERT INTO gateway.limiter_slots (provider, instance)
        VALUES (${provider}, ${this.#instance})
        RETURNING id`;
      return { id: slot!.id };
    });
  }

  async run<T>(provider: string, maxQueueMs: number, task: (queuedMs: number) => Promise<T>) {
    const limit = this.#limits[provider];
    if (!limit || (limit.rpm === undefined && limit.concurrency === undefined)) return task(0);

    const enqueued = performance.now();
    let slot: string | undefined;
    let outage: unknown;
    this.#waiting.set(provider, (this.#waiting.get(provider) ?? 0) + 1);
    try {
      while (slot === undefined) {
        let outcome: Acquired;
        try {
          outcome = await this.#acquire(provider, limit);
        } catch (error) {
          outage = error;
          break;
        }
        if ("id" in outcome) {
          slot = outcome.id;
          break;
        }
        const left = maxQueueMs - (performance.now() - enqueued);
        if (left <= 0) {
          throw new QueueTimeoutError(
            `no free slot for '${provider}' within ${maxQueueMs} ms (limit shared between gateway instances)`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(outcome.retryMs, left)));
      }
    } finally {
      this.#waiting.set(provider, (this.#waiting.get(provider) ?? 1) - 1);
    }

    if (slot === undefined) {
      // A database outage must not fail searches: hold to this instance's own limits instead.
      this.#onError(outage);
      const waited = performance.now() - enqueued;
      return this.#fallback.run(provider, Math.max(0, maxQueueMs - waited), (queuedMs) =>
        task(waited + queuedMs),
      );
    }

    try {
      return await task(performance.now() - enqueued);
    } finally {
      // If this fails the slot simply ages out; the request itself already has its answer.
      await this.#sql`
        UPDATE gateway.limiter_slots SET released_at = now() WHERE id = ${slot}`.catch(() => {});
    }
  }
}
