import { describe, expect, it } from "vitest";
import { brave } from "../src/providers/brave.ts";
import { exa } from "../src/providers/exa.ts";
import { fastcrw } from "../src/providers/fastcrw.ts";
import { firecrawl } from "../src/providers/firecrawl.ts";
import { providers } from "../src/providers/index.ts";
import { parallel } from "../src/providers/parallel.ts";
import { tavily } from "../src/providers/tavily.ts";
import { you } from "../src/providers/you.ts";
import { searchParamsSchema, type SearchParams } from "../src/schema.ts";

const now = new Date("2026-11-09T22:00:00.000Z");
const params = (overrides: Partial<SearchParams> = {}): SearchParams =>
  searchParamsSchema.parse({ query: "fed rate decision", maxResults: 5, ...overrides });
const ctx = (overrides: Partial<SearchParams> = {}) => ({
  params: params(overrides),
  receivedAt: now,
});

describe("registry", () => {
  it("has unique ids and env vars", () => {
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
    expect(new Set(providers.map((p) => p.envVar)).size).toBe(providers.length);
  });

  it.each(providers)("$id tolerates an empty or malformed body", (provider) => {
    expect(provider.parseResponse({}, ctx()).results).toEqual([]);
    expect(provider.parseResponse(null, ctx()).results).toEqual([]);
  });
});

describe("tavily", () => {
  it("builds the request", () => {
    const request = tavily.buildRequest(
      params({ topic: "news", freshness: "week", includeDomains: ["sec.gov"] }),
      "key",
      now,
    );
    expect(request.url).toBe("https://api.tavily.com/search");
    expect(request.headers.Authorization).toBe("Bearer key");
    expect(request.body).toEqual({
      query: "fed rate decision",
      max_results: 5,
      topic: "news",
      time_range: "week",
      include_domains: ["sec.gov"],
      include_published_date: true,
      include_usage: true,
    });
  });

  it("parses results, usage and request id", () => {
    const parsed = tavily.parseResponse(
      {
        results: [
          {
            url: "https://www.cnbc.com/a.html",
            title: "Fed rate decision",
            content: "The Federal Reserve on Wednesday...",
            score: 0.85,
            published_date: "Wed, 16 Sep 2026 18:00:14 GMT",
          },
        ],
        usage: { credits: 1 },
        request_id: "req-1",
      },
      ctx({ topic: "news" }),
    );
    expect(parsed).toEqual({
      results: [
        {
          url: "https://www.cnbc.com/a.html",
          title: "Fed rate decision",
          snippet: "The Federal Reserve on Wednesday...",
          publishedAt: "2026-09-16T18:00:14.000Z",
          publishedRaw: "Wed, 16 Sep 2026 18:00:14 GMT",
          publishedPrecision: "datetime",
          score: 0.85,
          source: "news",
        },
      ],
      usage: { credits: 1 },
      upstreamRequestId: "req-1",
    });
  });
});

describe("brave", () => {
  it("uses the web endpoint and freshness codes", () => {
    const url = new URL(
      brave.buildRequest(params({ freshness: "day", country: "us" }), "key", now).url,
    );
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "fed rate decision",
      count: "5",
      freshness: "pd",
      country: "US",
    });
  });

  it("uses the news endpoint and fills an open-ended date range", () => {
    const url = new URL(
      brave.buildRequest(params({ topic: "news", startDate: "2026-11-01" }), "key", now).url,
    );
    expect(url.pathname).toBe("/res/v1/news/search");
    expect(url.searchParams.get("freshness")).toBe("2026-11-01to2026-11-09");
  });

  it("parses web results and strips markup", () => {
    const parsed = brave.parseResponse(
      {
        web: {
          results: [
            {
              url: "https://www.federalreserve.gov/x.htm",
              title: "FOMC statement",
              description:
                "range at <strong>3-3/4 to 4 percent</strong>, the Fed&#x27;s mandate &amp; more",
              page_age: "2026-10-28T00:00:00",
            },
          ],
        },
      },
      ctx(),
    );
    expect(parsed.results[0]).toMatchObject({
      snippet: "range at 3-3/4 to 4 percent, the Fed's mandate & more",
      publishedAt: "2026-10-28T00:00:00.000Z",
      source: "web",
    });
  });

  it("parses news results from the top level", () => {
    const parsed = brave.parseResponse(
      { results: [{ url: "https://a.com/n", title: "N", description: "d", age: "1 hour ago" }] },
      ctx({ topic: "news" }),
    );
    expect(parsed.results[0]).toMatchObject({
      source: "news",
      publishedAt: "2026-11-09T21:00:00.000Z",
      publishedPrecision: "relative",
    });
  });
});

describe("exa", () => {
  it("turns freshness into an absolute start date", () => {
    const request = exa.buildRequest(params({ topic: "news", freshness: "hour" }), "key", now);
    expect(request.headers["x-api-key"]).toBe("key");
    expect(request.body).toEqual({
      query: "fed rate decision",
      numResults: 5,
      category: "news",
      startPublishedDate: "2026-11-09T21:00:00.000Z",
      contents: { highlights: true },
    });
  });

  it("parses highlights and cost", () => {
    const parsed = exa.parseResponse(
      {
        requestId: "r1",
        results: [
          {
            url: "https://a.com",
            title: "A",
            publishedDate: "2026-10-28T18:00:18.000Z",
            highlights: ["one", "two"],
          },
        ],
        costDollars: { total: 0.007 },
      },
      ctx(),
    );
    expect(parsed.results[0]).toMatchObject({
      snippet: "one\n...\ntwo",
      publishedAt: "2026-10-28T18:00:18.000Z",
    });
    expect(parsed.usage).toEqual({ costUsd: 0.007 });
    expect(parsed.upstreamRequestId).toBe("r1");
  });
});

describe("parallel", () => {
  it("nests filters under advanced_settings", () => {
    const request = parallel.buildRequest(
      params({ freshness: "week", excludeDomains: ["x.com"], country: "US" }),
      "key",
      now,
    );
    expect(request.body).toEqual({
      objective: "fed rate decision",
      search_queries: ["fed rate decision"],
      advanced_settings: {
        max_results: 5,
        source_policy: { exclude_domains: ["x.com"], after_date: "2026-11-02" },
        location: "us",
      },
    });
  });

  it("parses date-only publish dates and SKU usage", () => {
    const parsed = parallel.parseResponse(
      {
        search_id: "search_1",
        results: [
          { url: "https://a.com", title: null, publish_date: "2026-10-28", excerpts: ["x"] },
        ],
        usage: [{ name: "sku_search", count: 1 }],
      },
      ctx(),
    );
    expect(parsed.results[0]).toMatchObject({
      title: "",
      snippet: "x",
      publishedAt: "2026-10-28T00:00:00.000Z",
      publishedPrecision: "date",
    });
    expect(parsed.usage).toEqual({ credits: 1 });
  });
});

describe("you", () => {
  it("builds the request with a date range", () => {
    const request = you.buildRequest(
      params({ startDate: "2026-11-01", endDate: "2026-11-05", country: "gb" }),
      "key",
      now,
    );
    expect(request.headers["X-API-Key"]).toBe("key");
    expect(request.body).toEqual({
      query: "fed rate decision",
      count: 5,
      freshness: "2026-11-01to2026-11-05",
      country: "GB",
    });
  });

  it("falls back to the description when there are no snippets", () => {
    const parsed = you.parseResponse(
      {
        results: {
          web: [
            {
              url: "https://a.com",
              title: "A",
              description: "desc",
              snippets: [],
              page_age: "2026-11-09T21:22:29",
            },
            { url: "https://b.com", title: "B", description: "desc", snippets: ["s1", "s2"] },
          ],
        },
        metadata: { search_uuid: "u1" },
      },
      ctx(),
    );
    expect(parsed.results.map((r) => r.snippet)).toEqual(["desc", "s1\n...\ns2"]);
    expect(parsed.results[0]?.publishedAt).toBe("2026-11-09T21:22:29.000Z");
    expect(parsed.upstreamRequestId).toBe("u1");
  });
});

describe("firecrawl", () => {
  it("maps freshness and custom ranges to tbs", () => {
    expect(
      firecrawl.buildRequest(params({ freshness: "hour", topic: "news" }), "key", now).body,
    ).toEqual({
      query: "fed rate decision",
      limit: 5,
      sources: ["news"],
      tbs: "qdr:h",
    });
    expect(
      firecrawl.buildRequest(params({ startDate: "2026-11-01", endDate: "2026-11-09" }), "key", now)
        .body?.tbs,
    ).toBe("cdr:1,cd_min:11/1/2026,cd_max:11/9/2026");
  });

  it("parses grouped results with relative news dates", () => {
    const parsed = firecrawl.parseResponse(
      {
        success: true,
        data: {
          web: [{ url: "https://a.com", title: "A", description: "d", position: 1 }],
          news: [
            { url: "https://n.com", title: "N", snippet: "s", date: "8 minutes ago", position: 1 },
          ],
        },
        creditsUsed: 2,
        id: "job-1",
      },
      ctx(),
    );
    expect(parsed.results).toMatchObject([
      { url: "https://a.com", snippet: "d", source: "web", publishedAt: null },
      {
        url: "https://n.com",
        snippet: "s",
        source: "news",
        publishedAt: "2026-11-09T21:52:00.000Z",
      },
    ]);
    expect(parsed.usage).toEqual({ credits: 2 });
  });
});

describe("fastcrw", () => {
  it("builds the request", () => {
    expect(fastcrw.buildRequest(params({ freshness: "day" }), "key", now).body).toEqual({
      query: "fed rate decision",
      limit: 5,
      sources: ["web"],
      tbs: "qdr:d",
    });
  });

  it("parses both the grouped and the flat response shape", () => {
    const item = {
      url: "https://a.com",
      title: "A",
      snippet: "s",
      score: 0.98,
      publishedDate: "Sep 16, 2026",
    };
    const grouped = fastcrw.parseResponse({ data: { news: [item] } }, ctx({ topic: "news" }));
    expect(grouped.results[0]).toMatchObject({
      source: "news",
      score: 0.98,
      publishedAt: "2026-09-16T00:00:00.000Z",
      publishedPrecision: "date",
    });
    const flat = fastcrw.parseResponse({ data: [item] }, ctx());
    expect(flat.results[0]?.source).toBe("web");
  });
});
