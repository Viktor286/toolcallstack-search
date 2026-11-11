import type { ProviderInfo, StatsResponse, Status, UsageResponse } from "./api.ts";
import { compact, usd } from "./format.ts";
import { byProviderOrder } from "./providers.ts";

/** Fewer recent calls than this say little about a provider's health. */
export const LOW_DATA = 5;
/** A balance snapshot older than this suggests the poller has stopped (it runs every 5 minutes by default). */
export const STALE_BALANCE_MS = 30 * 60_000;
/** Spend at or above this share of a cap is a warning. */
export const WARN_SHARE = 0.8;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Point = StatsResponse["points"][number];
type ProviderHealth = Status["providers"][number];
export type Balance = NonNullable<UsageResponse["providers"][number]["balance"]>;

export interface ProviderActivity {
  calls: number;
  failures: number;
  cost: number | null;
  /** The worst hour's 95th percentile, the same figure the Usage page shows. */
  p95: number | null;
  /** One entry per hour, oldest first, ending with the current hour. */
  hourly: { start: string; calls: number; failures: number }[];
}

/**
 * Hourly stats folded into one summary and one 24-hour series per provider.
 * Points outside the series are left out of the totals too, so the figures
 * always add up to what the bars show.
 */
export function activityByProvider(
  points: Point[],
  now: number,
  hours = 24,
): Map<string, ProviderActivity> {
  const last = Math.floor(now / HOUR) * HOUR;
  const starts = Array.from({ length: hours }, (_, index) => last - (hours - 1 - index) * HOUR);
  const result = new Map<string, ProviderActivity>();
  for (const point of points) {
    const position = starts.indexOf(Date.parse(point.bucket));
    if (position === -1) continue;
    let activity = result.get(point.provider);
    if (!activity) {
      activity = {
        calls: 0,
        failures: 0,
        cost: null,
        p95: null,
        hourly: starts.map((start) => ({
          start: new Date(start).toISOString(),
          calls: 0,
          failures: 0,
        })),
      };
      result.set(point.provider, activity);
    }
    activity.calls += point.calls;
    activity.failures += point.failures;
    if (point.costUsd !== null) activity.cost = (activity.cost ?? 0) + point.costUsd;
    if (point.p95LatencyMs !== null) activity.p95 = Math.max(activity.p95 ?? 0, point.p95LatencyMs);
    const slot = activity.hourly[position]!;
    slot.calls += point.calls;
    slot.failures += point.failures;
  }
  return result;
}

/**
 * How urgently a provider needs a look; lower is worse. Providers that are
 * down, degraded or budget-blocked come first, idle ones last.
 */
export function attention(provider: ProviderHealth, calls24h: number): number {
  if (!provider.configured) return 5;
  if (provider.status === "down") return 0;
  if (provider.status === "degraded" || provider.budgetBlocked) return 1;
  if (provider.status === "healthy") return 2;
  // After a restart health is empty even though the call log has traffic.
  return calls24h > 0 ? 3 : 4;
}

/** Start of the oldest hour in a 24-slot series ending with the current hour. */
export const seriesStart = (now: number, hours = 24): Date =>
  new Date(Math.floor(now / HOUR) * HOUR - (hours - 1) * HOUR);

/** Providers that have something to show on a full card. */
export const isActive = (rank: number): boolean => rank <= 3;

export function byAttention(
  providers: ProviderHealth[],
  calls: (id: string) => number,
): { provider: ProviderHealth; rank: number }[] {
  return providers
    .map((provider) => ({ provider, rank: attention(provider, calls(provider.id)) }))
    .toSorted((a, b) => a.rank - b.rank || byProviderOrder(a.provider.id, b.provider.id));
}

export function healthCounts(providers: ProviderHealth[]) {
  const configured = providers.filter((provider) => provider.configured);
  const count = (status: ProviderHealth["status"]) =>
    configured.filter((provider) => provider.status === status).length;
  return {
    configured: configured.length,
    healthy: count("healthy"),
    degraded: count("degraded"),
    down: count("down"),
    /** No calls since the gateway started, so nothing to judge yet. */
    idle: count("unknown"),
    blocked: configured.filter((provider) => provider.budgetBlocked).length,
  };
}

/** A green badge on one or two calls would claim more than the data supports. */
export function statusLabel(provider: ProviderHealth): string | undefined {
  if (provider.status === "unknown") return "No calls since start";
  if (provider.status === "healthy" && provider.recentCalls < LOW_DATA) {
    return `Healthy · ${provider.recentCalls} ${provider.recentCalls === 1 ? "call" : "calls"}`;
  }
  return undefined;
}

export function successLabel(provider: ProviderHealth): string {
  if (provider.successRate === null) return "–";
  if (provider.recentCalls < LOW_DATA) {
    return `${provider.recentCalls} ${provider.recentCalls === 1 ? "call" : "calls"} so far`;
  }
  return `${Math.round(provider.successRate * 100)}% of last ${provider.recentCalls}`;
}

/** Hours until a balance runs out at the pace of the loaded window, or null when that cannot be told. */
export function runwayHours(balance: Balance): number | null {
  const { remaining } = balance.latest;
  const window = balance.window;
  if (remaining === null || !window || window.spent === null || window.spent <= 0) return null;
  const hours = (Date.parse(window.last.takenAt) - Date.parse(window.first.takenAt)) / HOUR;
  if (hours < 1) return null;
  return remaining / (window.spent / hours);
}

/** "about 3 d"; null when the runway is long enough not to matter. */
export function runwayLabel(hours: number): string | null {
  if (hours > 60 * 24) return null;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `about ${Math.round(hours)} h`;
  return `about ${Math.round(hours / 24)} d`;
}

export const isStale = (takenAt: string, now: number): boolean =>
  now - Date.parse(takenAt) > STALE_BALANCE_MS;

/** When today's cap will be reached at the pace so far, if that is before the UTC day ends. */
export function capReachedAt(spent: number, cap: number, now: number): Date | null {
  const dayStart = Math.floor(now / DAY) * DAY;
  const elapsed = now - dayStart;
  if (elapsed < HOUR || spent <= 0 || spent >= cap) return null;
  const reaches = now + ((cap - spent) / spent) * elapsed;
  return reaches < dayStart + DAY ? new Date(reaches) : null;
}

export type MeterLevel = "normal" | "warning" | "critical";

export function meterLevel(spent: number, cap: number): MeterLevel {
  if (cap <= 0 || spent >= cap) return "critical";
  return spent / cap >= WARN_SHARE ? "warning" : "normal";
}

/** What the Balance row says; `known` is false when there is no figure to show. */
export function balanceText(
  balance: Balance | undefined,
  info: ProviderInfo | undefined,
  store: Status["store"],
): { text: string; known: boolean } {
  const unit = balance?.unit;
  const show = (value: number) => (unit === "usd" ? usd(value) : `${compact(value)} credits`);
  if (balance?.latest.remaining != null) {
    return { text: `${show(balance.latest.remaining)} left`, known: true };
  }
  if (balance?.latest.used != null)
    return { text: `${show(balance.latest.used)} used`, known: true };
  if (!info) return { text: "not reported", known: false };
  if (!info.reportsBalance) {
    return {
      text: info.balanceEnvVar ? `set ${info.balanceEnvVar} to read` : "no balance API",
      known: false,
    };
  }
  return {
    text: store === "ok" ? "not read yet" : "needs the call log",
    known: false,
  };
}
