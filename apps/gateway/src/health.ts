import type { SearchResponse } from "./schema.ts";

const WINDOW = 20;

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
 * Health of each provider as seen through real traffic since the process
 * started: the outcome of the most recent calls, held in memory.
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
    if (state.samples.length > WINDOW) state.samples.shift();
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
      state.consecutiveFailures >= 3
        ? "down"
        : state.consecutiveFailures > 0 || successRate < 0.8
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
