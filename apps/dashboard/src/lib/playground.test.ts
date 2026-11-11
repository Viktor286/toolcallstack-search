import { describe, expect, it } from "vitest";
import type { SearchResponse } from "./api";
import {
  EMPTY_FORM,
  HISTORY_SIZE,
  addToHistory,
  buildRequest,
  cappedProviders,
  findInHistory,
  parseHistory,
  resultChoices,
  withoutCache,
  type HistoryEntry,
  curlCommand,
  formFromParams,
  formToParams,
  hasAdvanced,
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
    expect(shared.get("https://a.com/1")).toEqual(["brave", "exa"]);
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

describe("hasAdvanced", () => {
  it("opens the panel only for a field inside it", () => {
    expect(hasAdvanced(form)).toBe(false);
    // Freshness and result count sit outside the panel.
    expect(hasAdvanced({ ...form, freshness: "day", maxResults: 10 })).toBe(false);
    expect(hasAdvanced(formFromParams(new URLSearchParams("q=x&country=US")))).toBe(true);
    expect(hasAdvanced({ ...form, includeRaw: true })).toBe(true);
    expect(hasAdvanced({ ...form, options: { brave: " " } })).toBe(false);
    expect(hasAdvanced({ ...form, options: { brave: '{"safesearch":"off"}' } })).toBe(true);
  });
});

describe("cache in the playground", () => {
  it("sends a valid cacheTtlSeconds, keeps it in the link and opens the panel for it", () => {
    const cached = { ...form, cacheTtlSeconds: "60" };
    expect(buildRequest(cached).body).toMatchObject({ cacheTtlSeconds: 60 });
    expect(buildRequest({ ...form, cacheTtlSeconds: "1.5" }).body).not.toHaveProperty(
      "cacheTtlSeconds",
    );
    expect(formFromParams(formToParams(cached)).cacheTtlSeconds).toBe("60");
    expect(hasAdvanced(cached)).toBe(true);
  });
});

describe("shared links", () => {
  it("carry each selected provider's options, compacted when they are valid JSON", () => {
    const params = formToParams({
      ...form,
      providers: ["brave", "exa"],
      options: { brave: '{ "safesearch": "off" }', exa: "{oops", you: '{"x":1}' },
    });
    expect(params.get("o.brave")).toBe('{"safesearch":"off"}');
    expect(params.get("o.exa")).toBe("{oops");
    expect(params.has("o.you")).toBe(false);
    expect(formFromParams(params).options).toEqual({
      brave: '{"safesearch":"off"}',
      exa: "{oops",
    });
  });
});

describe("result counts", () => {
  it("offer counts up to the largest chosen provider's limit, keeping the current one", () => {
    expect(resultChoices([20, 100], 5)).toEqual([3, 5, 10, 20, 50, 100]);
    expect(resultChoices([20], 7)).toEqual([3, 5, 7, 10, 20]);
    expect(resultChoices([], 5)).toEqual([3, 5, 10, 20]);
  });

  it("name the providers that will be capped", () => {
    const providers = [
      { id: "brave", maxResults: 20 },
      { id: "exa", maxResults: 100 },
    ];
    expect(cappedProviders(providers, 50).map((provider) => provider.id)).toEqual(["brave"]);
    expect(cappedProviders(providers, 20)).toEqual([]);
  });
});

describe("withoutCache", () => {
  it("asks for a fresh answer without changing the original request", () => {
    const request = buildRequest(form);
    expect(withoutCache(request).body.cacheTtlSeconds).toBe(0);
    expect(request.body.cacheTtlSeconds).toBeUndefined();
  });
});

function entry(query: string, id = query): HistoryEntry {
  const entryForm = { ...form, query };
  return {
    id,
    savedAt: "2026-11-10T12:00:00.000Z",
    form: entryForm,
    request: buildRequest(entryForm),
    body: { ...response("brave", ["https://a.com"]), raw: { big: true } },
  };
}

describe("history", () => {
  it("keeps the newest runs first, replaces a repeat of the same set-up and drops raw bodies", () => {
    let entries: HistoryEntry[] = [];
    for (let index = 0; index < HISTORY_SIZE + 2; index++) {
      entries = addToHistory(entries, entry(`q${index}`));
    }
    expect(entries).toHaveLength(HISTORY_SIZE);
    expect(entries[0]!.form.query).toBe(`q${HISTORY_SIZE + 1}`);
    expect("raw" in entries[0]!.body).toBe(false);

    entries = addToHistory(entries, entry("q5", "again"));
    expect(entries[0]!.id).toBe("again");
    expect(entries.filter((item) => item.form.query === "q5")).toHaveLength(1);
  });

  it("drops stored entries that are not runs and fills fields older entries lack", () => {
    const { options: _options, ...oldForm } = entry("old").form;
    const stored = JSON.stringify([
      { ...entry("old"), form: oldForm },
      { id: "broken", form: null },
      "nonsense",
    ]);
    const entries = parseHistory(stored);
    expect(entries.map((item) => item.id)).toEqual(["old"]);
    expect(entries[0]!.form.options).toEqual({});
    expect(formToParams(entries[0]!.form).get("q")).toBe("old");
    expect(parseHistory("{not json")).toEqual([]);
    expect(parseHistory(null)).toEqual([]);
  });

  it("finds the run for the set-up in the address bar", () => {
    const entries = addToHistory([], entry("fed rates"));
    expect(findInHistory(entries, formFromParams(formToParams(entries[0]!.form)))?.id).toBe(
      "fed rates",
    );
    expect(findInHistory(entries, { ...form, query: "other" })).toBeUndefined();
  });
});
