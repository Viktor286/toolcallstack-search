import type { SearchResponse } from "./schema.ts";

/** How many recent calls per provider health is judged on. */
export const HEALTH_WINDOW = 20;
/** Failures in a row that make a provider "down". */
export const DOWN_AFTER = 3;
/** Below this share of successes a provider is "degraded". */
export const HEALTHY_SHARE = 0.8;

export type ProviderStatus = "healthy" | "degraded" | "down" | "unknown";

interface Sample {
  ok: boolean;
  latencyMs: number;
}

interface State {
  samples: Sample[];
  consecutiveFailures: number;
  lastOkAt: string | null;
  lastError: { type: string; message: string; at: string } | null;
}

/**
 * Health of each provider as seen through real traffic: the outcome of the
 * most recent calls, held in memory since the process started, or reloaded
 * from the call log when instances share state.
 */
export class HealthTracker {
  readonly #states = new Map<string, State>();

  record(response: SearchResponse): void {
    // These say nothing about the provider: nothing was sent to it.
    const type = response.error?.type;
    if (
      type === "unknown_provider" ||
      type === "not_configured" ||
      type === "throttled" ||
      type === "budget_exceeded"
    ) {
      return;
    }

    const state = this.#states.get(response.provider) ?? {
      samples: [],
      consecutiveFailures: 0,
      lastOkAt: null,
      lastError: null,
    };
    state.samples.push({ ok: response.ok, latencyMs: response.timing.latencyMs });
    if (state.samples.length > HEALTH_WINDOW) state.samples.shift();
    if (response.ok) {
      state.consecutiveFailures = 0;
      state.lastOkAt = response.timing.receivedAt;
    } else if (response.error) {
      state.consecutiveFailures += 1;
      state.lastError = {
        type: response.error.type,
        message: response.error.message,
        at: response.timing.receivedAt,
      };
    }
    this.#states.set(response.provider, state);
  }

  /** Set a provider's recent outcomes, oldest first, to what the call log says. */
  replace(
    provider: string,
    outcomes: {
      ok: boolean;
      latencyMs: number;
      receivedAt: string;
      error: { type: string; message: string } | null;
    }[],
  ): void {
    const recent = outcomes.slice(-HEALTH_WINDOW);
    const lastOk = recent.findLast((outcome) => outcome.ok);
    const lastFailed = recent.findLast((outcome) => !outcome.ok && outcome.error);
    this.#states.set(provider, {
      samples: recent.map(({ ok, latencyMs }) => ({ ok, latencyMs })),
      consecutiveFailures: recent.length - 1 - recent.findLastIndex((outcome) => outcome.ok),
      lastOkAt: lastOk?.receivedAt ?? null,
      lastError: lastFailed?.error ? { ...lastFailed.error, at: lastFailed.receivedAt } : null,
    });
  }

  snapshot(provider: string) {
    const state = this.#states.get(provider);
    if (!state || state.samples.length === 0) {
      return {
        status: "unknown" as ProviderStatus,
        recentCalls: 0,
        successRate: null,
        medianLatencyMs: null,
        consecutiveFailures: 0,
        lastOkAt: null,
        lastError: null,
      };
    }
    const okCalls = state.samples.filter((sample) => sample.ok);
    const successRate = okCalls.length / state.samples.length;
    const latencies = okCalls.map((sample) => sample.latencyMs).toSorted((a, b) => a - b);
    const status: ProviderStatus =
      state.consecutiveFailures >= DOWN_AFTER
        ? "down"
        : state.consecutiveFailures > 0 || successRate < HEALTHY_SHARE
          ? "degraded"
          : "healthy";
    return {
      status,
      recentCalls: state.samples.length,
      successRate: Math.round(successRate * 100) / 100,
      medianLatencyMs:
        latencies.length > 0 ? Math.round(latencies[Math.floor(latencies.length / 2)]!) : null,
      consecutiveFailures: state.consecutiveFailures,
      lastOkAt: state.lastOkAt,
      lastError: state.lastError,
    };
  }
}
