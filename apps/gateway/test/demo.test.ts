import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { demoResponse } from "../src/providers/demo.ts";
import type { BatchResponse, SearchResponse } from "../src/schema.ts";

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(env: Record<string, string>, overrides: Record<string, string> = {}) {
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", ...overrides }),
    env,
    sleep: async () => {},
    // A real request would mean the demo leaked onto the network.
    transport: async (request) => {
      throw new Error(`unexpected upstream request to ${request.url}`);
    },
  });
  close = () => app.close();
  return app;
}

const search = (body: Record<string, unknown>) => ({
  method: "POST" as const,
  url: "/v1/search",
  payload: { options: { latencyMs: 1 }, ...body },
});

describe("demo mode", () => {
  it("offers the demo providers when no real provider has a key", async () => {
    const app = await setup({});
    const { providers } = (await app.inject("/v1/providers")).json();
    const demo = providers.filter((p: { id: string }) => p.id.startsWith("demo-"));
    expect(demo.map((p: { id: string; configured: boolean }) => [p.id, p.configured])).toEqual([
      ["demo-a", true],
      ["demo-b", true],
    ]);
    expect((await app.inject("/llms.txt")).body).toContain("`demo-a`, configured");
  });

  it("hides them once a real provider is configured, unless asked for", async () => {
    const app = await setup({ TAVILY_API_KEY: "tvly-test" });
    const ids = (await app.inject("/v1/providers"))
      .json()
      .providers.map((p: { id: string }) => p.id);
    expect(ids).not.toContain("demo-a");
    expect((await app.inject("/v1/providers/demo-a")).statusCode).toBe(404);
    const refused = await app.inject(search({ provider: "demo-a", query: "x" }));
    expect(refused.json().error.type).toBe("not_configured");
    await app.close();

    const forced = await setup({ TAVILY_API_KEY: "tvly-test" }, { DEMO_MODE: "true" });
    const all = (await forced.inject("/v1/providers")).json().providers;
    expect(all.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(["tavily", "demo-b"]),
    );
  });

  it("can be switched off", async () => {
    const app = await setup({}, { DEMO_MODE: "false" });
    const { providers } = (await app.inject("/v1/providers")).json();
    expect(providers.some((p: { id: string }) => p.id.startsWith("demo-"))).toBe(false);
  });

  it("answers a search through the whole pipeline without any network", async () => {
    const app = await setup({});
    const reply = await app.inject(
      search({ provider: "demo-a", query: "rate decision", maxResults: 4, topic: "news" }),
    );
    expect(reply.statusCode).toBe(200);
    const body: SearchResponse = reply.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(4);
    expect(body.results[0]).toMatchObject({ position: 1, source: "news" });
    expect(body.results[0]!.title).toContain("rate decision");
    expect(body.results.every((result) => new URL(result.url).hostname.includes("example."))).toBe(
      true,
    );
    expect(body.results.every((result) => result.publishedAt !== null)).toBe(true);
    expect(body.usage).toEqual({ estimatedCostUsd: 0, costSource: "estimated" });
    expect(body.timing.phases?.ttfbMs).toBeGreaterThan(0);
  });

  it("gives the two providers different answers to the same query", async () => {
    const app = await setup({});
    const reply = await app.inject({
      method: "POST",
      url: "/v1/search/batch",
      payload: {
        providers: ["demo-a", "demo-b"],
        query: "postgres pooling",
        maxResults: 6,
        country: "US",
        options: { latencyMs: 1 },
      },
    });
    const [a, b] = (reply.json() as BatchResponse).responses;
    expect(a!.results.map((r) => r.url)).not.toEqual(b!.results.map((r) => r.url));
    expect(a!.warnings).toEqual([]);
    expect(b!.warnings).toEqual(["country is not supported and was ignored"]);
    expect(a!.results.every((r) => r.score !== null)).toBe(true);
    expect(b!.results.some((r) => r.publishedAt === null)).toBe(true);
  });

  it("simulates failures on request, so retries and fallbacks can be seen", async () => {
    const app = await setup({});
    const failed = await app.inject(
      search({
        provider: "demo-a",
        query: "x",
        maxRetries: 2,
        options: { status: 503, latencyMs: 1 },
      }),
    );
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({
      error: { type: "upstream_error", upstreamStatus: 503 },
      retries: { count: 2 },
    });

    const slow = await app.inject(
      search({
        provider: "demo-a",
        query: "x",
        maxRetries: 0,
        timeoutMs: 100,
        options: { latencyMs: 5000 },
      }),
    );
    expect(slow.json().error.type).toBe("timeout");
  });
});

describe("demoResponse", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const hosts = (query: string) =>
    (
      demoResponse(new URL(`demo://demo-a/search?q=x&count=20&${query}`), now).body as {
        results: { url: string; published: string }[];
      }
    ).results;

  it("is deterministic", () => {
    expect(hosts("")).toEqual(hosts(""));
    expect(hosts("")).toHaveLength(14);
  });

  it("applies freshness and domain filters", () => {
    for (const result of hosts("freshness=day")) {
      expect(now.getTime() - Date.parse(result.published)).toBeLessThanOrEqual(86_400_000);
    }
    expect(hosts("freshness=hour")).toHaveLength(1);
    expect(hosts("include=example.org").every((r) => r.url.includes(".example.org/"))).toBe(true);
    expect(hosts("exclude=example.org").some((r) => r.url.includes(".example.org/"))).toBe(false);
  });
});
