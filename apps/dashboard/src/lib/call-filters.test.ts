import { describe, expect, it } from "vitest";
import { callsQuery, filtersFromParams, filtersToParams, hourLink } from "./call-filters";

describe("call filters", () => {
  it("round-trip through the address bar, dropping what is unset or invalid", () => {
    const filters = filtersFromParams(
      new URLSearchParams("provider=tavily&ok=maybe&errorType=timeout&range=7d&q=fed"),
    );
    expect(filters).toMatchObject({
      provider: "tavily",
      ok: "",
      errorType: "timeout",
      range: "7d",
      q: "fed",
    });
    expect(filtersToParams(filters).toString()).toBe(
      "provider=tavily&q=fed&errorType=timeout&range=7d",
    );
    expect(filtersFromParams(new URLSearchParams("errorType=nope&range=1y"))).toMatchObject({
      errorType: "",
      range: "all",
    });
  });

  it("turn a recent range into a window anchored at now, and let an exact one win", () => {
    const now = Date.parse("2026-11-10T12:00:00.000Z");
    const recent = filtersFromParams(new URLSearchParams("range=1h&errorType=timeout"));
    expect(callsQuery(recent, now)).toMatchObject({
      from: "2026-11-10T11:00:00.000Z",
      to: undefined,
      ok: "false",
    });
    const exact = filtersFromParams(
      new URLSearchParams("range=1h&from=2026-11-09T10:00:00.000Z&to=2026-11-09T11:00:00.000Z"),
    );
    expect(callsQuery(exact, now)).toMatchObject({
      from: "2026-11-09T10:00:00.000Z",
      to: "2026-11-09T11:00:00.000Z",
    });
  });

  it("link an hour's bar to that hour's calls", () => {
    expect(hourLink("exa", "2026-11-09T10:00:00.000Z")).toBe(
      "/calls?provider=exa&from=2026-11-09T10%3A00%3A00.000Z&to=2026-11-09T11%3A00%3A00.000Z",
    );
  });
});
