import { describe, expect, it } from "vitest";
import type { Status } from "./api.ts";
import {
  activityByProvider,
  attention,
  balanceText,
  byAttention,
  capReachedAt,
  healthCounts,
  isStale,
  meterLevel,
  seriesStart,
  runwayHours,
  runwayLabel,
  statusLabel,
  successLabel,
  type Balance,
} from "./overview.ts";

type Health = Status["providers"][number];

const health = (over: Partial<Health> = {}): Health => ({
  id: "brave",
  configured: true,
  status: "healthy",
  recentCalls: 20,
  successRate: 1,
  medianLatencyMs: 400,
  consecutiveFailures: 0,
  lastOkAt: null,
  lastError: null,
  queueDepth: 0,
  budgetBlocked: null,
  ...over,
});

const point = (bucket: string, over = {}) => ({
  bucket,
  provider: "brave",
  calls: 10,
  failures: 1,
  retries: 0,
  p50LatencyMs: 300,
  p95LatencyMs: 900,
  cacheHits: 0,
  avgQueuedMs: null,
  costUsd: 0.05,
  ...over,
});

describe("activityByProvider", () => {
  const now = Date.parse("2026-11-10T12:30:00Z");

  it("gives an included provider without calls an empty 24-hour series", () => {
    const quiet = activityByProvider([], now, 24, ["exa"]).get("exa")!;
    expect(quiet).toMatchObject({ calls: 0, failures: 0, cost: null, p95: null });
    expect(quiet.hourly).toHaveLength(24);
    expect(quiet.hourly.every((slot) => slot.calls === 0)).toBe(true);
  });

  it("totals the 24-slot series and leaves out hours before it", () => {
    const result = activityByProvider(
      [
        point("2026-11-10T12:00:00.000Z"),
        point("2026-11-10T11:00:00.000Z", { calls: 4, failures: 0, p95LatencyMs: 1500 }),
        point("2026-11-09T12:00:00.000Z", { costUsd: null }),
      ],
      now,
    );
    const brave = result.get("brave")!;
    // The 12:00 bucket a day earlier is a partial 25th hour: neither drawn nor counted.
    expect(brave.calls).toBe(14);
    expect(brave.failures).toBe(1);
    expect(brave.cost).toBeCloseTo(0.1);
    expect(brave.p95).toBe(1500);
    expect(brave.hourly).toHaveLength(24);
    expect(brave.hourly.at(-1)).toMatchObject({ calls: 10, failures: 1 });
    expect(brave.hourly.at(-2)).toMatchObject({ calls: 4 });
    expect(brave.hourly[0]).toMatchObject({ start: "2026-11-09T13:00:00.000Z", calls: 0 });
  });

  it("asks for history from the start of the series' oldest hour", () => {
    expect(seriesStart(now).toISOString()).toBe("2026-11-09T13:00:00.000Z");
  });

  it("keeps cost null when no call was priced", () => {
    const result = activityByProvider([point("2026-11-10T12:00:00.000Z", { costUsd: null })], now);
    expect(result.get("brave")!.cost).toBeNull();
  });
});

describe("attention", () => {
  it("ranks trouble first and idle providers last", () => {
    const ordered = byAttention(
      [
        health({ id: "tavily" }),
        health({ id: "exa", configured: false }),
        health({ id: "you", status: "unknown", recentCalls: 0 }),
        health({ id: "brave", status: "down" }),
        health({ id: "fastcrw", budgetBlocked: "daily cap" }),
      ],
      () => 0,
    ).map((row) => row.provider.id);
    expect(ordered).toEqual(["brave", "fastcrw", "tavily", "you", "exa"]);
  });

  it("treats unknown health with logged traffic as active", () => {
    const quiet = health({ status: "unknown", recentCalls: 0 });
    expect(attention(quiet, 0)).toBe(4);
    expect(attention(quiet, 12)).toBe(3);
  });
});

describe("health wording", () => {
  it("does not claim certainty from a few calls", () => {
    expect(statusLabel(health({ recentCalls: 1 }))).toBe("Healthy · 1 call");
    expect(statusLabel(health({ recentCalls: 3 }))).toBe("Healthy · 3 calls");
    expect(statusLabel(health())).toBeUndefined();
    expect(statusLabel(health({ status: "down", recentCalls: 1 }))).toBeUndefined();
    expect(successLabel(health({ recentCalls: 1 }))).toBe("1 call so far");
    expect(successLabel(health({ recentCalls: 20, successRate: 0.95 }))).toBe("95% of last 20");
    expect(successLabel(health({ successRate: null }))).toBe("–");
  });

  it("counts configured providers by status", () => {
    expect(
      healthCounts([
        health(),
        health({ status: "degraded" }),
        health({ status: "down" }),
        health({ configured: false, status: "unknown" }),
      ]),
    ).toEqual({ configured: 3, healthy: 1, degraded: 1, down: 1, idle: 0, blocked: 0 });
    expect(healthCounts([health({ status: "unknown", recentCalls: 0 })]).idle).toBe(1);
  });
});

const balance = (remaining: number | null, spent: number | null, hours = 24): Balance => ({
  unit: "credits",
  latest: { takenAt: "2026-11-10T12:00:00Z", remaining, used: null, quota: null },
  window: {
    first: { takenAt: "2026-11-09T12:00:00Z", remaining: null, used: null, quota: null },
    last: {
      takenAt: new Date(Date.parse("2026-11-09T12:00:00Z") + hours * 3_600_000).toISOString(),
      remaining,
      used: null,
      quota: null,
    },
    spent,
    spentPerOkCall: null,
  },
});

const info = (over = {}) =>
  ({ reportsBalance: false, balanceEnvVar: null, ...over }) as Parameters<typeof balanceText>[1];
describe("balance", () => {
  it("projects the runway from the window's pace", () => {
    expect(runwayHours(balance(100, 50))).toBeCloseTo(48);
    expect(runwayHours(balance(100, 0))).toBeNull();
    expect(runwayHours(balance(null, 50))).toBeNull();
    expect(runwayHours(balance(100, 50, 0.5))).toBeNull();
  });

  it("words the runway and hides a distant one", () => {
    expect([0.5, 5, 72, 24 * 90].map(runwayLabel)).toEqual([
      "under an hour",
      "about 5 h",
      "about 3 d",
      null,
    ]);
  });

  it("flags snapshots that stopped arriving", () => {
    const now = Date.parse("2026-11-10T12:40:00Z");
    expect(isStale("2026-11-10T12:30:00Z", now)).toBe(false);
    expect(isStale("2026-11-10T11:30:00Z", now)).toBe(true);
  });

  it("explains why a balance is missing", () => {
    expect(balanceText(undefined, info(), "ok").text).toBe("no balance API");
    expect(balanceText(undefined, info({ balanceEnvVar: "EXA_SERVICE_KEY" }), "ok").text).toBe(
      "set EXA_SERVICE_KEY to read",
    );
    expect(balanceText(undefined, info({ reportsBalance: true }), "ok").text).toBe("not read yet");
    expect(balanceText(undefined, info({ reportsBalance: true }), "none").text).toBe(
      "needs the call log",
    );
    expect(balanceText(balance(460, null), info(), "ok")).toEqual({
      text: "460 credits left",
      known: true,
    });
  });
});

describe("budget forecast", () => {
  it("warns from 80% and fails at the cap", () => {
    expect([meterLevel(10, 100), meterLevel(80, 100), meterLevel(100, 100)]).toEqual([
      "normal",
      "warning",
      "critical",
    ]);
  });

  it("projects when today's cap is reached, only if before the day ends", () => {
    const noon = Date.parse("2026-11-10T12:00:00Z");
    // 60 of 100 in 12 hours: the other 40 take 8 more hours.
    expect(capReachedAt(60, 100, noon)?.toISOString()).toBe("2026-11-10T20:00:00.000Z");
    // 10 of 100 in 12 hours would take far past midnight.
    expect(capReachedAt(10, 100, noon)).toBeNull();
    expect(capReachedAt(0, 100, noon)).toBeNull();
    expect(capReachedAt(100, 100, noon)).toBeNull();
    // Too early in the day to extrapolate.
    expect(capReachedAt(5, 10, Date.parse("2026-11-10T00:20:00Z"))).toBeNull();
  });
});
