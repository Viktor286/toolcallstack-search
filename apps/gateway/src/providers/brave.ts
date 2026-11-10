import { parsePublished, toDateOnly } from "../dates.ts";
import { asArray, asString, isRecord, stripHtml } from "../util.ts";
import type { Provider } from "./types.ts";

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

export const brave: Provider = {
  id: "brave",
  name: "Brave Search API",
  docs: "https://api-dashboard.search.brave.com/app/documentation/web-search/query",
  envVar: "BRAVE_API_KEY",
  features: ["topic:news", "freshness", "startDate", "endDate", "country"],
  maxResults: 20,
  notes: [
    '`topic: "news"` uses the separate news index, which returns publish dates for every result.',
    "Options are sent as query-string parameters, e.g. `extra_snippets`, `search_lang`, `safesearch`, `offset`.",
    "Snippets arrive as HTML; the gateway strips the markup.",
  ],
  pricing: { perRequestUsd: 0.005 },

  buildRequest(params, apiKey, now) {
    const vertical = params.topic === "news" ? "news" : "web";
    const url = new URL(`https://api.search.brave.com/res/v1/${vertical}/search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(params.maxResults));
    if (params.startDate || params.endDate) {
      // Brave needs both ends of a custom range.
      const start = params.startDate ?? "1990-01-01";
      const end = params.endDate ?? toDateOnly(now);
      url.searchParams.set("freshness", `${start}to${end}`);
    } else if (params.freshness) {
      url.searchParams.set(
        "freshness",
        FRESHNESS[params.freshness === "hour" ? "day" : params.freshness],
      );
    }
    if (params.country) url.searchParams.set("country", params.country.toUpperCase());
    return {
      method: "GET",
      url: url.toString(),
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    };
  },

  parseResponse(body, { params, receivedAt }) {
    const data = isRecord(body) ? body : {};
    const news = params.topic === "news";
    // News responses carry results at the top level; web responses nest them under `web`.
    const items = news ? data.results : isRecord(data.web) ? data.web.results : [];
    return {
      results: asArray(items).map((item) => ({
        url: asString(item.url),
        title: stripHtml(asString(item.title)),
        snippet: stripHtml(asString(item.description)),
        ...parsePublished(item.page_age ?? item.age, receivedAt),
        score: null,
        source: news ? "news" : "web",
      })),
    };
  },
};
