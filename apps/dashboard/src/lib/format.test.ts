import { describe, expect, it } from "vitest";
import { ago, callCost, compact, duration, ms, percent, usd } from "./format.ts";
import { byProviderOrder, providerColor } from "./providers.ts";

describe("format", () => {
  it("formats durations", () => {
    expect([ms(null), ms(0.4), ms(842.4), ms(1240), ms(43_900)]).toEqual([
      "–",
      "<1 ms",
      "842 ms",
      "1.24 s",
      "43.9 s",
    ]);
    expect([duration(42), duration(125), duration(3725), duration(90_000)]).toEqual([
      "42s",
      "2 min",
      "1 h 2 min",
      "1 d 1 h",
    ]);
  });

  it("formats money without rounding small calls to zero", () => {
    expect([usd(undefined), usd(0), usd(0.005), usd(0.00083), usd(12.5)]).toEqual([
      "–",
      "$0",
      "$0.0050",
      "$0.0008",
      "$12.50",
    ]);
    expect(callCost({ costUsd: 0.007, estimatedCostUsd: 0.005 })).toBe(0.007);
    expect(callCost({ estimatedCostUsd: 0.005 })).toBe(0.005);
    expect(callCost({})).toBeNull();
  });

  it("formats counts, shares and ages", () => {
    expect([compact(1284), compact(12_900), compact(4_200_000)]).toEqual([
      "1,284",
      "12.9K",
      "4.2M",
    ]);
    expect([percent(1, 0), percent(1, 3), percent(1, 400), percent(0, 5)]).toEqual([
      "–",
      "33%",
      "0.3%",
      "0%",
    ]);
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect([
      ago(null, now),
      ago("2026-11-10T11:59:30Z", now),
      ago("2026-11-10T09:00:00Z", now),
    ]).toEqual(["never", "30s ago", "3 h ago"]);
  });
});

describe("providers", () => {
  it("gives each provider a fixed colour slot", () => {
    expect(providerColor("brave")).toBe("var(--series-1)");
    expect(providerColor("you")).toBe("var(--series-7)");
    expect(providerColor("new-one")).toBe("var(--series-other)");
    expect(["you", "zzz", "brave", "aaa", "exa"].toSorted(byProviderOrder)).toEqual([
      "brave",
      "exa",
      "you",
      "aaa",
      "zzz",
    ]);
  });
});
