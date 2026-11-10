import { parsePublished } from "../dates.ts";
import { asArray, asNumber, asString, compact, isRecord } from "../util.ts";
import type { Provider } from "./types.ts";

const QDR = { hour: "h", day: "d", week: "w", month: "m", year: "y" } as const;

/** Google-style custom date range wants M/D/YYYY. */
function usDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}/${year}`;
}

export const firecrawl: Provider = {
  id: "firecrawl",
  name: "Firecrawl",
  docs: "https://docs.firecrawl.dev/features/search",
  envVar: "FIRECRAWL_API_KEY",
  features: [
    "topic:news",
    "freshness",
    "freshness:hour",
    "startDate",
    "endDate",
    "includeDomains",
    "excludeDomains",
  ],
  maxResults: 100,
  notes: [
    'Only news results carry a date, and it is relative ("8 minutes ago"), so `publishedPrecision` is `relative`.',
    "Date filters apply to web results only.",
    "Useful options: `scrapeOptions` to fetch page contents (extra credits), `location`, `categories`.",
  ],
  // Price per credit depends on the plan; this is the Standard plan rate.
  pricing: { perCreditUsd: 0.00083 },
  balance: {
    request: ({ apiKey }) => ({
      url: "https://api.firecrawl.dev/v2/team/credit-usage",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    parse(body) {
      const data = isRecord(body) && isRecord(body.data) ? body.data : {};
      const remaining = asNumber(data.remainingCredits);
      if (remaining === null) return null;
      return { unit: "credits", remaining, used: null, quota: asNumber(data.planCredits) };
    },
  },

  buildRequest(params, apiKey) {
    let tbs: string | undefined;
    if (params.startDate || params.endDate) {
      tbs = [
        "cdr:1",
        params.startDate && `cd_min:${usDate(params.startDate)}`,
        params.endDate && `cd_max:${usDate(params.endDate)}`,
      ]
        .filter(Boolean)
        .join(",");
    } else if (params.freshness) {
      tbs = `qdr:${QDR[params.freshness]}`;
    }
    return {
      method: "POST",
      url: "https://api.firecrawl.dev/v2/search",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: compact({
        query: params.query,
        limit: params.maxResults,
        sources: [params.topic === "news" ? "news" : "web"],
        tbs,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
      }),
    };
  },

  parseResponse(body, { receivedAt }) {
    const data = isRecord(body) ? body : {};
    const groups = isRecord(data.data) ? data.data : {};
    const credits = asNumber(data.creditsUsed);
    const map = (source: "web" | "news") =>
      asArray(groups[source]).map((item) => ({
        url: asString(item.url),
        title: asString(item.title),
        snippet: asString(item.description) || asString(item.snippet),
        ...parsePublished(item.date, receivedAt),
        score: null,
        source,
      }));
    return {
      results: [...map("web"), ...map("news")],
      usage: credits === null ? undefined : { credits },
      upstreamRequestId: asString(data.id) || undefined,
    };
  },
};
