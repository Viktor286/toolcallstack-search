import { describe, expect, it } from "vitest";
import type { SearchResponse } from "./api";
import {
  EMPTY_FORM,
  buildRequest,
  curlCommand,
  formFromParams,
  formToParams,
  normalizeUrl,
  parseOptions,
  sharedResults,
  snapshotName,
  summarize,
  unsupportedParams,
} from "./playground";

const form = { ...EMPTY_FORM, query: " fed rates ", providers: ["brave"] };

function response(label: string, urls: string[], dates: (string | null)[] = []): SearchResponse {
  return {
    label,
    results: urls.map((url, index) => ({ url, publishedAt: dates[index] ?? null })),
  } as unknown as SearchResponse;
}

describe("buildRequest", () => {
  it("sends one provider to /v1/search and leaves defaults out", () => {
    expect(buildRequest(form)).toEqual({
      path: "/v1/search",
      body: { provider: "brave", query: "fed rates", maxResults: 5 },
    });
  });

  it("includes only the parameters that were chosen", () => {
    const { body } = buildRequest({
      ...form,
      topic: "news",
      freshness: "day",
      country: "us",
      includeDomains: "https://www.reuters.com/markets, ft.com",
      includeRaw: true,
      options: { brave: '{"safesearch":"off"}' },
    });
    expect(body).toEqual({
      provider: "brave",
      query: "fed rates",
      maxResults: 5,
      topic: "news",
      freshness: "day",
      includeDomains: ["www.reuters.com", "ft.com"],
      country: "US",
      includeRaw: true,
      options: { safesearch: "off" },
    });
  });

  it("sends several providers as a batch, with options only on the provider they belong to", () => {
    const request = buildRequest({
      ...form,
      providers: ["brave", "tavily"],
      options: { tavily: '{"search_depth":"advanced"}', exa: '{"type":"fast"}' },
    });
    expect(request.path).toBe("/v1/search/batch");
    expect(request.body.providers).toEqual([
      "brave",
      { provider: "tavily", options: { search_depth: "advanced" } },
    ]);
    expect(request.body).not.toHaveProperty("options");
  });
});

describe("parseOptions", () => {
  it("accepts an object, and nothing at all", () => {
    expect(parseOptions(' {"a":1} ')).toEqual({ value: { a: 1 } });
    expect(parseOptions("  ")).toEqual({});
  });

  it("rejects broken JSON and non-objects", () => {
    expect(parseOptions("{a").error).toBeTruthy();
    expect(parseOptions("[1]").error).toMatch(/object/);
  });
});

describe("unsupportedParams", () => {
  it("names what a provider will ignore", () => {
    const provider = { features: ["freshness", "includeDomains"] };
    expect(
      unsupportedParams(provider, {
        topic: "news",
        freshness: "hour",
        includeDomains: ["a.com"],
        country: "US",
      }),
    ).toEqual(["news topic", "past-hour freshness", "country"]);
    expect(unsupportedParams(provider, { freshness: "week" })).toEqual([]);
    expect(unsupportedParams({ features: [] }, { freshness: "hour" })).toEqual(["freshness"]);
  });
});

describe("curlCommand", () => {
  it("escapes quotes and never contains a key", () => {
    const command = curlCommand(
      { path: "/v1/search", body: { query: "it's" } },
      "http://localhost:4310",
      true,
    );
    expect(command).toContain("curl -s http://localhost:4310/v1/search");
    expect(command).toContain("it'\\''s");
    expect(command).toContain("$GATEWAY_API_KEY");
  });
});

describe("result overlap", () => {
  it("treats the same page as one result whatever the URL decoration", () => {
    expect(normalizeUrl("https://www.Example.com/a/?utm_source=x&b=2#top")).toBe(
      normalizeUrl("http://example.com/a?b=2"),
    );
    expect(normalizeUrl("https://example.com/a?id=1")).not.toBe(
      normalizeUrl("https://example.com/a?id=2"),
    );
  });

  it("counts shared, unique and dated results", () => {
    const brave = response(
      "brave",
      ["https://a.com/1", "https://b.com/2"],
      ["2026-01-02T00:00:00.000Z", "2026-01-05T00:00:00.000Z"],
    );
    const exa = response("exa", ["http://www.a.com/1/", "https://c.com/3"]);
    const shared = sharedResults([brave, exa]);
    expect(shared.get("a.com/1")).toEqual(["brave", "exa"]);
    expect(summarize(brave, shared)).toEqual({
      results: 2,
      dated: 2,
      unique: 1,
      newestAt: "2026-01-05T00:00:00.000Z",
    });
    expect(summarize(exa, shared)).toMatchObject({ dated: 0, unique: 1, newestAt: null });
  });
});

describe("sharing a set-up", () => {
  it("round-trips the form through the address bar", () => {
    const filled = {
      ...EMPTY_FORM,
      query: "fed rates",
      providers: ["brave", "exa"],
      topic: "news" as const,
      freshness: "week",
      maxResults: 10,
      includeDomains: "reuters.com",
      includeRaw: true,
    };
    expect(formFromParams(formToParams(filled))).toEqual(filled);
    expect(formToParams(EMPTY_FORM).toString()).toBe("");
  });

  it("names a snapshot after the query and time", () => {
    expect(snapshotName("Fed: rate decision?", new Date("2026-11-10T14:05:09.123Z"))).toBe(
      "search-fed-rate-decision-2026-11-10T14-05-09.json",
    );
  });
});
