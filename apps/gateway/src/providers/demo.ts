import { createHash } from "node:crypto";
import type { Transport } from "../transport.ts";
import { asArray, asNumber, asString, isRecord } from "../util.ts";
import type { Feature, Provider } from "./types.ts";

/**
 * Two built-in providers that answer from inside the gateway, so the API, the
 * dashboard and the playground can be tried without an account anywhere. They
 * go through the same pipeline as a real provider (limits, retries, cost, call
 * log); only the network is missing: `withDemo` answers their requests locally.
 */

const HOUR = 3_600_000;
const FRESHNESS_HOURS = { hour: 1, day: 24, week: 168, month: 720, year: 8760 } as const;

interface Page {
  host: string;
  path: string;
  title: string;
  news: boolean;
  /** Age of the page when it is returned. */
  ageHours: number;
}

// Hosts under example.* are reserved for documentation, so no link leads anywhere real.
const PAGES: Page[] = [
  { host: "news.example.com", path: "latest", title: "Latest on {q}", news: true, ageHours: 0.4 },
  { host: "wire.example.net", path: "live", title: "{q}: live updates", news: true, ageHours: 2 },
  {
    host: "news.example.com",
    path: "analysis",
    title: "Analysis: what {q} means",
    news: true,
    ageHours: 9,
  },
  {
    host: "daily.example.org",
    path: "report",
    title: "{q}, the full report",
    news: true,
    ageHours: 30,
  },
  {
    host: "wire.example.net",
    path: "timeline",
    title: "Timeline of {q}",
    news: true,
    ageHours: 100,
  },
  {
    host: "daily.example.org",
    path: "opinion",
    title: "Opinion: rethinking {q}",
    news: true,
    ageHours: 400,
  },
  {
    host: "docs.example.com",
    path: "reference",
    title: "{q} reference documentation",
    news: false,
    ageHours: 60,
  },
  {
    host: "wiki.example.org",
    path: "wiki",
    title: "{q}: overview and background",
    news: false,
    ageHours: 2000,
  },
  {
    host: "blog.example.com",
    path: "guide",
    title: "A practical guide to {q}",
    news: false,
    ageHours: 500,
  },
  { host: "forum.example.net", path: "t", title: "Discussion: {q}", news: false, ageHours: 20 },
  {
    host: "learn.example.org",
    path: "intro",
    title: "Understanding {q} in five minutes",
    news: false,
    ageHours: 5000,
  },
  {
    host: "blog.example.com",
    path: "faq",
    title: "{q}: frequently asked questions",
    news: false,
    ageHours: 900,
  },
  {
    host: "papers.example.org",
    path: "abs",
    title: "Research notes on {q}",
    news: false,
    ageHours: 3000,
  },
  {
    host: "forum.example.net",
    path: "q",
    title: "Common mistakes with {q}",
    news: false,
    ageHours: 150,
  },
];

/** A stable number in [0, 1) for a piece of text, so the same query always ranks the same way. */
function fraction(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0) / 2 ** 32;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "query"
  );
}

interface Variant {
  id: string;
  name: string;
  features: Feature[];
  /** Typical response time; each query lands within 30% of it. */
  latencyMs: number;
  /** Whether results carry a relevance score. */
  scores: boolean;
  /** Share of results returned without a publish date, as some real providers do. */
  undated: number;
  about: string;
}

const VARIANTS: Variant[] = [
  {
    id: "demo-a",
    name: "Demo A",
    features: [
      "topic:news",
      "freshness",
      "freshness:hour",
      "startDate",
      "endDate",
      "includeDomains",
      "excludeDomains",
      "country",
    ],
    latencyMs: 140,
    scores: true,
    undated: 0,
    about: "Fast, honours every unified parameter, dates and scores every result.",
  },
  {
    id: "demo-b",
    name: "Demo B",
    features: ["topic:news", "freshness", "excludeDomains"],
    latencyMs: 480,
    scores: false,
    undated: 0.5,
    about:
      "Slower, supports fewer parameters and leaves half its results undated, to show how the gateway reports such gaps.",
  },
];

const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The response body a demo provider "returns" for one request URL. */
export function demoResponse(url: URL, now: Date): { status: number; body: unknown } {
  const variant = VARIANTS.find((entry) => entry.id === url.hostname);
  const param = (name: string) => url.searchParams.get(name) ?? "";
  const status = Number(param("status")) || 200;
  if (!variant) return { status: 404, body: { error: "no such demo provider" } };
  if (status !== 200) return { status, body: { error: `simulated failure (status ${status})` } };

  const query = param("q");
  const list = (name: string) => param(name).split(",").filter(Boolean);
  const include = list("include");
  const exclude = list("exclude");
  const maxAgeHours = Math.min(
    FRESHNESS_HOURS[param("freshness") as keyof typeof FRESHNESS_HOURS] ?? Infinity,
    param("start") ? (now.getTime() - Date.parse(param("start"))) / HOUR : Infinity,
  );
  const minAgeHours = param("end")
    ? (now.getTime() - Date.parse(param("end")) - 24 * HOUR) / HOUR
    : -Infinity;

  const results = PAGES.filter(
    (page) =>
      (param("topic") === "news" ? page.news : true) &&
      page.ageHours <= maxAgeHours &&
      page.ageHours >= minAgeHours &&
      (include.length === 0 || include.some((domain) => matches(page.host, domain))) &&
      !exclude.some((domain) => matches(page.host, domain)),
  )
    .map((page) => ({ page, score: fraction(`${variant.id}|${query}|${page.host}/${page.path}`) }))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, Number(param("count")) || 10)
    .map(({ page, score }) => ({
      url: `https://${page.host}/${page.path}/${slug(query)}`,
      title: page.title.replace("{q}", query),
      text: `Demo result for "${query}". The gateway made this text up locally; no search provider was called and the link leads nowhere.`,
      published:
        fraction(`${variant.id}|date|${page.host}/${page.path}`) < variant.undated
          ? null
          : new Date(now.getTime() - page.ageHours * HOUR).toISOString(),
      ...(variant.scores ? { score: Math.round((0.5 + score / 2) * 100) / 100 } : {}),
      news: page.news,
    }));
  return { status: 200, body: { demo: true, provider: variant.id, results } };
}

function demoProvider(variant: Variant): Provider {
  return {
    id: variant.id,
    name: variant.name,
    docs: "https://github.com/Viktor286/toolcallstack-search#demo-mode",
    envVar: "DEMO_MODE",
    features: variant.features,
    maxResults: PAGES.length,
    pricing: { perRequestUsd: 0 },
    notes: [
      `Built-in demo provider: results are generated inside the gateway, nothing is sent anywhere and nothing is billed. ${variant.about}`,
      "Timing is simulated. `options.latencyMs` sets the response time and `options.status` (e.g. `503` or `429`) makes the call fail, which shows retries and fallbacks.",
    ],

    buildRequest(params) {
      const url = new URL(`demo://${variant.id}/search`);
      const set = (name: string, value: string | undefined) => {
        if (value) url.searchParams.set(name, value);
      };
      set("q", params.query);
      set("count", String(params.maxResults));
      set("topic", params.topic);
      set("freshness", params.freshness);
      set("start", params.startDate);
      set("end", params.endDate);
      set("include", params.includeDomains?.join(","));
      set("exclude", params.excludeDomains?.join(","));
      set("country", params.country);
      return { method: "GET", url: url.toString(), headers: {} };
    },

    parseResponse(body) {
      const data = isRecord(body) ? body : {};
      return {
        results: asArray(data.results).map((item) => ({
          url: asString(item.url),
          title: asString(item.title),
          snippet: asString(item.text),
          publishedAt: asString(item.published) || null,
          publishedRaw: asString(item.published) || null,
          publishedPrecision: item.published ? ("datetime" as const) : null,
          score: asNumber(item.score),
          source: item.news ? ("news" as const) : ("web" as const),
        })),
      };
    },
  };
}

export const demoProviders: Provider[] = VARIANTS.map(demoProvider);

/**
 * Answer `demo://` requests in-process and pass everything else on. The wait
 * and the timing phases are simulated in fixed proportions of the response time.
 */
export function withDemo(transport: Transport): Transport {
  return async (request) => {
    if (!request.url.startsWith("demo://")) return transport(request);
    const url = new URL(request.url);
    const typical = VARIANTS.find((entry) => entry.id === url.hostname)?.latencyMs ?? 100;
    const asked = Number(url.searchParams.get("latencyMs"));
    const latencyMs =
      Number.isFinite(asked) && asked > 0
        ? asked
        : typical * (0.7 + 0.6 * fraction(`latency|${request.url}`));

    await new Promise((resolve) => setTimeout(resolve, Math.min(latencyMs, request.timeoutMs)));
    if (latencyMs > request.timeoutMs) {
      const error = new Error(`no response within ${request.timeoutMs} ms`);
      error.name = "TimeoutError";
      throw error;
    }
    const { status, body } = demoResponse(url, new Date());
    return {
      status,
      headers: { "content-type": "application/json" },
      text: JSON.stringify(body),
      phases: {
        dnsMs: latencyMs * 0.04,
        connectMs: latencyMs * 0.1,
        tlsMs: latencyMs * 0.16,
        ttfbMs: latencyMs * 0.62,
        downloadMs: latencyMs * 0.08,
        connectionReused: false,
      },
    };
  };
}
