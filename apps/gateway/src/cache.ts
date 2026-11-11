import type { SearchParams, SearchResponse } from "./schema.ts";

/** What a later identical call can reuse from a successful one. */
export interface CacheEntry {
  callId: string;
  results: SearchResponse["results"];
  warnings: string[];
  upstream: SearchResponse["upstream"];
  /** Kept only when the call asked for it with `includeRaw`, to bound memory. */
  raw?: unknown;
  hasRaw: boolean;
  storedAt: number;
  expiresAt: number;
}

export type Claim =
  /** An answer to reuse; `shared` when it came from an identical call that was in flight. */
  | { reused: CacheEntry; shared: boolean }
  /** No answer to reuse: this call goes upstream and must report how it ended. */
  | { finish(entry: Omit<CacheEntry, "storedAt" | "expiresAt"> | null): void };

/** JSON with object keys sorted, so the same params always give the same key. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The parts of a request that decide the provider's answer. Operational knobs
 * (timeouts, retries, queueing, includeRaw) do not change it.
 */
export function cacheKey(provider: string, params: SearchParams): string {
  const { query, maxResults, topic, freshness, startDate, endDate } = params;
  const { includeDomains, excludeDomains, country, options } = params;
  return `${provider}|${stable({ query, maxResults, topic, freshness, startDate, endDate, includeDomains, excludeDomains, country, options })}`;
}

/**
 * Recent successful answers, in memory per gateway instance, least recently
 * used dropped first. It also merges identical calls in flight: the second
 * waits for the first one's answer instead of sending its own request.
 */
export class ResponseCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<CacheEntry | null>>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(maxEntries: number, now: () => number = Date.now) {
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  #usable(entry: CacheEntry | null | undefined, maxAgeMs: number, needRaw: boolean) {
    return (
      entry !== null &&
      entry !== undefined &&
      (!needRaw || entry.hasRaw) &&
      this.#now() < entry.expiresAt &&
      this.#now() - entry.storedAt <= maxAgeMs
    );
  }

  /**
   * Reuse an answer no older than `maxAgeMs`, or the one an identical call in
   * flight is about to get; otherwise register this call as the one in flight.
   * `ttlMs` is how long this call's own answer is kept.
   */
  async claim(
    key: string,
    { maxAgeMs, ttlMs, needRaw }: { maxAgeMs: number; ttlMs: number; needRaw: boolean },
  ): Promise<Claim> {
    const stored = this.#entries.get(key);
    if (stored && this.#usable(stored, maxAgeMs, needRaw)) {
      // Most recently used goes to the end of the eviction order.
      this.#entries.delete(key);
      this.#entries.set(key, stored);
      return { reused: stored, shared: false };
    }
    if (stored && this.#now() >= stored.expiresAt) this.#entries.delete(key);

    const pending = this.#pending.get(key);
    if (pending) {
      const entry = await pending;
      if (entry && (!needRaw || entry.hasRaw)) return { reused: entry, shared: true };
      // The call in flight failed, or kept no raw body: look again, and make the call if need be.
      return this.claim(key, { maxAgeMs, ttlMs, needRaw });
    }

    let settle!: (entry: CacheEntry | null) => void;
    this.#pending.set(key, new Promise((resolve) => (settle = resolve)));
    return {
      finish: (answer) => {
        this.#pending.delete(key);
        const entry = answer && {
          ...answer,
          storedAt: this.#now(),
          expiresAt: this.#now() + ttlMs,
        };
        if (entry && ttlMs > 0) {
          this.#entries.delete(key);
          this.#entries.set(key, entry);
          while (this.#entries.size > this.#maxEntries) {
            this.#entries.delete(this.#entries.keys().next().value!);
          }
        }
        settle(entry);
      },
    };
  }
}
