import { describe, expect, it } from "vitest";
import { freshnessStart, parsePublished } from "../src/dates.ts";

const received = new Date("2026-11-09T22:00:00.000Z");

describe("parsePublished", () => {
  it.each([
    ["2026-10-28", "2026-10-28T00:00:00.000Z", "date"],
    ["2026-10-28T18:00:18.000Z", "2026-10-28T18:00:18.000Z", "datetime"],
    ["2026-10-14T16:44:56", "2026-10-14T16:44:56.000Z", "datetime"],
    ["2026-10-14T16:44:56+02:00", "2026-10-14T14:44:56.000Z", "datetime"],
    ["Wed, 16 Sep 2026 18:00:14 GMT", "2026-09-16T18:00:14.000Z", "datetime"],
    ["Sep 16, 2026", "2026-09-16T00:00:00.000Z", "date"],
    ["8 minutes ago", "2026-11-09T21:52:00.000Z", "relative"],
    ["2 hours ago", "2026-11-09T20:00:00.000Z", "relative"],
    ["an hour ago", "2026-11-09T21:00:00.000Z", "relative"],
    ["1 day ago", "2026-11-08T22:00:00.000Z", "relative"],
  ])("parses %s", (raw, publishedAt, publishedPrecision) => {
    expect(parsePublished(raw, received)).toEqual({
      publishedAt,
      publishedRaw: raw,
      publishedPrecision,
    });
  });

  it("keeps the raw value when the format is unknown", () => {
    expect(parsePublished("sometime last spring", received)).toEqual({
      publishedAt: null,
      publishedRaw: "sometime last spring",
      publishedPrecision: null,
    });
  });

  it.each([undefined, null, "", 42])("treats %s as no date", (raw) => {
    expect(parsePublished(raw, received).publishedRaw).toBeNull();
  });
});

describe("freshnessStart", () => {
  it("subtracts the window from now", () => {
    expect(freshnessStart("hour", received).toISOString()).toBe("2026-11-09T21:00:00.000Z");
    expect(freshnessStart("week", received).toISOString()).toBe("2026-11-02T22:00:00.000Z");
  });
});
