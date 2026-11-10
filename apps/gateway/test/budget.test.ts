import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget.ts";
import { redact } from "../src/util.ts";

const usage = (credits: number, usd: number) =>
  ({ credits, estimatedCostUsd: usd, costSource: "estimated" }) as const;

describe("BudgetTracker", () => {
  it("allows everything for a provider without a budget", () => {
    const tracker = new BudgetTracker({});
    expect(tracker.reserve("a")).toBeNull();
    expect(tracker.snapshot("a")).toBeNull();
  });

  it("counts requests in flight against the call cap", () => {
    const tracker = new BudgetTracker({ a: { daily: { calls: 2 } } });
    expect(tracker.reserve("a")).toBeNull();
    expect(tracker.reserve("a")).toBeNull();
    expect(tracker.reserve("a")).toContain("daily budget");
    // A failed request frees its slot without being billed.
    tracker.settle("a", null);
    expect(tracker.reserve("a")).toBeNull();
    tracker.settle("a", usage(1, 0.008));
    tracker.settle("a", usage(1, 0.008));
    expect(tracker.snapshot("a")?.daily?.spent).toEqual({ calls: 2, usd: 0.016, credits: 2 });
    expect(tracker.reserve("a")).toContain("2 of 2 calls");
  });

  it("prefers the reported cost over the estimate", () => {
    const tracker = new BudgetTracker({ a: { monthly: { usd: 1 } } });
    tracker.reserve("a");
    tracker.settle("a", { costUsd: 0.5, estimatedCostUsd: 0.1, costSource: "reported" });
    expect(tracker.snapshot("a")?.monthly?.spent.usd).toBe(0.5);
  });

  it("resets the day at UTC midnight and the month at its start", () => {
    let now = new Date("2026-11-30T23:59:00Z");
    const tracker = new BudgetTracker(
      { a: { daily: { credits: 2 }, monthly: { credits: 3 } } },
      () => now,
    );
    const spend = (credits: number) => {
      const blocked = tracker.reserve("a");
      if (blocked === null) tracker.settle("a", usage(credits, 0));
      return blocked;
    };
    expect(spend(2)).toBeNull();
    expect(spend(1)).toContain("daily budget");
    expect(spend(1)).toContain("resets at 00:00 UTC");

    now = new Date("2026-12-01T00:00:01Z");
    // A new day and a new month: both windows are empty again.
    expect(spend(2)).toBeNull();
    expect(spend(1)).toContain("daily budget");
    now = new Date("2026-12-02T00:00:01Z");
    expect(spend(1)).toBeNull();
    expect(spend(1)).toContain("monthly budget");
    expect(tracker.windows()).toEqual({
      dayStart: new Date("2026-12-02T00:00:00Z"),
      monthStart: new Date("2026-12-01T00:00:00Z"),
    });
  });

  it("adds seeded spend and enforces a balance floor", () => {
    const tracker = new BudgetTracker({ a: { daily: { calls: 5 }, minRemaining: 100 } });
    tracker.seed("a", { calls: 4, usd: 0, credits: 0 }, { calls: 30, usd: 0, credits: 0 });
    expect(tracker.reserve("a")).toBeNull();
    expect(tracker.reserve("a")).toContain("5 calls");
    tracker.settle("a", null);

    // Unknown balance does not block; a balance at the floor does.
    expect(tracker.snapshot("a")).toMatchObject({ minRemaining: 100, remaining: null });
    tracker.setBalance("a", 101);
    expect(tracker.blocked("a")).toBeNull();
    tracker.setBalance("a", 100);
    expect(tracker.blocked("a")).toContain("at or below the floor of 100");
    expect(tracker.snapshot("a")?.blocked).toContain("floor");
  });

  it("lists spend for metrics", () => {
    const tracker = new BudgetTracker({});
    tracker.reserve("a");
    tracker.settle("a", usage(2, 0.01));
    expect(tracker.spent()).toEqual([
      { provider: "a", period: "daily", spend: { calls: 1, usd: 0.01, credits: 2 } },
      { provider: "a", period: "monthly", spend: { calls: 1, usd: 0.01, credits: 2 } },
    ]);
  });
});

describe("redact", () => {
  it("blanks secret-looking strings at any depth and leaves the rest alone", () => {
    const input = {
      apiKey: "a",
      api_key: "b",
      key: "c",
      keywords: "d",
      n: 1,
      deep: [{ password: "p" }],
    };
    expect(redact(input)).toEqual({
      apiKey: "[redacted]",
      api_key: "[redacted]",
      key: "[redacted]",
      keywords: "d",
      n: 1,
      deep: [{ password: "[redacted]" }],
    });
    expect(input.apiKey).toBe("a");
    expect(redact("plain")).toBe("plain");
    expect(redact(null)).toBeNull();
  });
});
