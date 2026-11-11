import { parsePublished } from "../dates.ts";
import { asArray, asNumber, asString, compact, isRecord } from "../util.ts";
import type { Provider } from "./types.ts";

const QDR = { hour: "h", day: "d", week: "w", month: "m", year: "y" } as const;

export const fastcrw: Provider = {
  id: "fastcrw",
  name: "fastCRW",
  docs: "https://docs.fastcrw.com/search",
  console: "https://fastcrw.com/dashboard",
  envVar: "FASTCRW_API_KEY",
  features: ["topic:news", "freshness", "freshness:hour"],
  maxResults: 20,
  notes: [
    "Dates are relative or day-precision text, mostly on news results.",
    "Useful options: `lang`, `categories`, `scrapeOptions`. `answer` and `summarizeResults` need an LLM key.",
    "A search costs 2 credits; the response does not report it.",
  ],
  limits: { rpm: 120, concurrency: 3 },
  balance: {
    request: ({ apiKey }) => ({
      url: "https://api.fastcrw.com/v1/account/balance",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    parse(body) {
      const data = isRecord(body) ? body : {};
      const remaining = asNumber(data.totalCreditsAvailable);
      if (remaining === null) return null;
      return {
        unit: "credits",
        remaining,
        used: null,
        quota: asNumber(data.monthlyCreditAllowance),
      };
    },
  },

  buildRequest(params, apiKey) {
    return {
      method: "POST",
      url: "https://api.fastcrw.com/v1/search",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: compact({
        query: params.query,
        limit: params.maxResults,
        sources: [params.topic === "news" ? "news" : "web"],
        tbs: params.freshness ? `qdr:${QDR[params.freshness]}` : undefined,
      }),
    };
  },

  parseResponse(body, { receivedAt }) {
    const data = isRecord(body) ? body : {};
    const map = (items: unknown, source: "web" | "news") =>
      asArray(items).map((item) => ({
        url: asString(item.url),
        title: asString(item.title),
        snippet: asString(item.snippet) || asString(item.description),
        ...parsePublished(item.publishedDate, receivedAt),
        score: asNumber(item.score),
        source,
      }));
    // `data` is a flat array when `sources` is unset and grouped by source otherwise.
    if (Array.isArray(data.data)) return { results: map(data.data, "web") };
    const groups = isRecord(data.data) ? data.data : {};
    return { results: [...map(groups.web, "web"), ...map(groups.news, "news")] };
  },
};
