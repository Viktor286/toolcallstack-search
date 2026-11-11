import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { BalanceSnapshot, CallRecord, ProviderSpend, Store } from "../src/store.ts";
import type { Phases } from "../src/transport.ts";

const env = { TAVILY_API_KEY: "tvly-test", YOU_API_KEY: "you-test" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const tavilyBody = {
  results: [
    { url: "https://a.com/1", title: "One", content: "first", score: 0.9 },
    { url: "", title: "No url", content: "dropped" },
    { url: "https://a.com/2", title: "Two", content: "second", score: 0.5 },
  ],
  usage: { credits: 1 },
  request_id: "req-1",
};

const phases: Phases = {
  dnsMs: 1,
  connectMs: 2,
  tlsMs: 3,
  ttfbMs: 40,
  downloadMs: 5,
  connectionReused: false,
};

/** What the call log reports as already spent when an app starts. */
let seededSpend: ProviderSpend[] = [];

function memoryStore() {
  const calls: CallRecord[] = [];
  const balances: BalanceSnapshot[] = [];
  const store: Store = {
    saveCall: async (record) => void calls.push(record),
    listCalls: async () => ({ calls: calls.map((call) => call.response), nextCursor: null }),
    getCall: async (id) => calls.find((call) => call.response.id === id)?.response ?? null,
    saveBalance: async (snapshot) => void balances.push(snapshot),
    usage: async () => [],
    usageByClient: async () => [],
    stats: async () => [],
    spendSince: async () => seededSpend,
    recentOutcomes: async () => [],
    cleanup: async () => ({ calls: 0, raws: 0 }),
    ping: async () => {},
    close: async () => {},
  };
  return { store, calls, balances };
}

/** Build an app whose upstream is `upstream`, a fetch-like function returning a Response. */
async function setup(
  upstream: (url: string, init: { method: string; body?: string }) => Promise<Response>,
  overrides: Record<string, string> = {},
  options: { limitWindowMs?: number } = {},
) {
  const { store, calls, balances } = memoryStore();
  const fetchMock = vi.fn(upstream);
  const sleeps: number[] = [];
  const app = await buildApp({
    sleep: async (ms) => void sleeps.push(ms),
    config: loadConfig({ LOG_LEVEL: "silent", BALANCE_POLL_SECONDS: "0", ...overrides }),
    store,
    env,
    limitWindowMs: options.limitWindowMs,
    transport: async (request) => {
      const response = await fetchMock(request.url, { method: request.method, body: request.body });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        text: await response.text(),
        phases,
      };
    },
  });
  return { app, calls, balances, fetchMock, sleeps };
}

function timeoutError(): Error {
  return Object.assign(new Error("timed out"), { name: "TimeoutError" });
}

let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  seededSpend = [];
});

describe("POST /v1/search", () => {
  it("returns unified results and stores the call", async () => {
    const { app, calls, fetchMock } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "hello", maxResults: 3 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      provider: "tavily",
      label: "tavily",
      ok: true,
      usage: { credits: 1, estimatedCostUsd: 0.008, costSource: "estimated" },
      upstream: { status: 200, requestId: "req-1" },
      error: null,
      fallback: { tried: [] },
    });
    expect(body.timing.phases).toEqual(phases);
    expect(body.timing.queuedMs).toBeLessThan(50);
    expect(body.retries.attempts[0]).toMatchObject({ phases, upstreamStatus: 200 });
    expect(body.results.map((r: { position: number; url: string }) => [r.position, r.url])).toEqual(
      [
        [1, "https://a.com/1"],
        [2, "https://a.com/2"],
      ],
    );
    expect(Date.parse(body.timing.receivedAt)).toBeGreaterThanOrEqual(
      Date.parse(body.timing.sentAt),
    );
    expect(body).not.toHaveProperty("raw");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "hello", max_results: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      batchId: null,
      groupId: null,
      keyFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
      raw: tavilyBody,
      response: { id: body.id },
    });
  });

  it("merges provider options into the upstream body and returns raw on request", async () => {
    const { app, fetchMock } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: {
        provider: "tavily",
        query: "hello",
        includeRaw: true,
        options: { search_depth: "advanced" },
      },
    });
    expect(response.json().raw).toEqual(tavilyBody);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).search_depth).toBe("advanced");
  });

  it("warns about params the provider cannot honour", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: {
        provider: "tavily",
        query: "hello",
        freshness: "hour",
        country: "us",
        maxResults: 50,
      },
    });
    expect(response.json().warnings).toEqual([
      "freshness 'hour' is not supported; widened to 'day'",
      "country is not supported and was ignored",
      "maxResults capped at 20",
      "1 result had no URL and was dropped",
    ]);
  });

  it.each([
    [429, "rate_limited", 429],
    [500, "upstream_error", 502],
    [401, "auth_error", 502],
    [403, "auth_error", 502],
    [402, "quota_exceeded", 502],
    [432, "quota_exceeded", 502],
    [400, "upstream_invalid_request", 422],
    [422, "upstream_invalid_request", 422],
  ])("maps upstream %i to %s", async (upstreamStatus, type, status) => {
    const { app } = await setup(async () => json({ detail: "nope" }, upstreamStatus));
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "hello" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ ok: false, error: { type, upstreamStatus } });
  });

  it("reports timeouts as 504", async () => {
    const { app } = await setup(async () => {
      throw timeoutError();
    });
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "hello", timeoutMs: 100, maxRetries: 1 },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.message).toBe("no response within 100 ms");
    expect(response.json().error.type).toBe("timeout");
  });

  it("reports network failures and non-JSON bodies as 502", async () => {
    const network = await setup(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    });
    close = () => network.app.close();
    const failed = await network.app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "hello" },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatchObject({
      type: "network",
      message: "fetch failed: ECONNREFUSED",
    });
    await network.app.close();

    const html = await setup(async () => new Response("<html>oops</html>"));
    close = () => html.app.close();
    const bad = await html.app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "hello" },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.type).toBe("bad_response");
  });

  it("rejects unknown and unconfigured providers without calling upstream", async () => {
    const { app, fetchMock } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "nope", query: "hello" },
    });
    expect(unknown.statusCode).toBe(404);
    const unconfigured = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "exa", query: "hello" },
    });
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.json().error.message).toContain("EXA_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the request body", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "", startDate: "yesterday" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request");
  });
});

const search = (app: Awaited<ReturnType<typeof setup>>["app"], extra: object = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/search",
    payload: { provider: "tavily", query: "hello", ...extra },
  });

describe("retries", () => {
  it("retries transient failures with exponential backoff and reports every attempt", async () => {
    const replies = [
      () => json({ error: "busy" }, 503),
      () => Promise.reject(new TypeError("fetch failed")),
      () => json({ error: "slow down" }, 429),
      () => json(tavilyBody),
    ];
    const { app, calls, fetchMock, sleeps } = await setup(async () => replies.shift()!());
    close = () => app.close();
    const response = await search(app);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.retries.count).toBe(3);
    expect(
      body.retries.attempts.map((a: { error: string; upstreamStatus: number }) => [
        a.error,
        a.upstreamStatus,
      ]),
    ).toEqual([
      ["upstream_error", 503],
      ["network", null],
      ["rate_limited", 429],
      [null, 200],
    ]);

    // Each wait falls in the upper half of a doubling step: 500, 1000, 2000 ms.
    expect(sleeps).toHaveLength(3);
    for (const [index, step] of [500, 1000, 2000].entries()) {
      expect(sleeps[index]).toBeGreaterThanOrEqual(step / 2);
      expect(sleeps[index]).toBeLessThanOrEqual(step);
    }
    expect(body.retries.attempts.map((a: { backoffMs: number }) => a.backoffMs)).toEqual([
      ...sleeps,
      null,
    ]);
    expect(body.retries.backoffMs).toBe(sleeps.reduce((sum, ms) => sum + ms, 0));

    // `timing` describes the final attempt; totalMs covers the whole call.
    expect(body.timing.sentAt).toBe(body.retries.attempts[3].sentAt);
    expect(body.timing.latencyMs).toBe(body.retries.attempts[3].latencyMs);
    expect(body.timing.totalMs).toBeGreaterThanOrEqual(body.timing.latencyMs);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.response.retries.count).toBe(3);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain(
      'toolcallstack_search_upstream_retries_total{provider="tavily",reason="rate_limited"} 1',
    );
  });

  it("gives up after five retries by default and caps the wait", async () => {
    const { app, fetchMock, sleeps } = await setup(async () => json({ error: "down" }, 500));
    close = () => app.close();
    const response = await search(app);
    expect(response.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(response.json().retries).toMatchObject({ count: 5 });
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(8000);
    expect(sleeps[4]).toBeGreaterThanOrEqual(4000);
  });

  it("honours maxRetries from the request, including zero", async () => {
    const { app, fetchMock, sleeps } = await setup(async () => json({ error: "down" }, 500));
    close = () => app.close();
    expect((await search(app, { maxRetries: 0 })).json().retries).toMatchObject({ count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await search(app, { maxRetries: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry failures that would repeat", async () => {
    const { app, fetchMock, sleeps } = await setup(async (url) =>
      url.includes("tavily") ? json({ detail: "bad key" }, 401) : new Response("<html>"),
    );
    close = () => app.close();
    expect((await search(app)).json().error.type).toBe("auth_error");
    expect((await search(app, { provider: "you" })).json().error.type).toBe("bad_response");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([]);
  });

  it("waits at least as long as Retry-After, within the cap", async () => {
    const replies = [
      () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
      () => new Response("{}", { status: 429, headers: { "retry-after": "600" } }),
      () => json(tavilyBody),
    ];
    const { app, sleeps } = await setup(async () => replies.shift()!());
    close = () => app.close();
    expect((await search(app)).statusCode).toBe(200);
    expect(sleeps).toEqual([3000, 8000]);
  });
});

describe("POST /v1/search/batch", () => {
  it("fans out, keeps order, and isolates failures", async () => {
    const { app, calls, fetchMock } = await setup(async (url) =>
      url.includes("tavily") ? json({ error: "down" }, 500) : json({ results: { web: [] } }),
    );
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search/batch",
      payload: {
        query: "hello",
        providers: [
          "tavily",
          "you",
          { provider: "you", label: "you+knowledge", options: { knowledge: "core" } },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.responses.map((r: { label: string; ok: boolean }) => [r.label, r.ok])).toEqual([
      ["tavily", false],
      ["you", true],
      ["you+knowledge", true],
    ]);

    const youBodies = fetchMock.mock.calls
      .filter(([url]) => url.includes("ydc-index"))
      .map(([, init]) => JSON.parse(String(init.body)).knowledge);
    expect(youBodies.toSorted()).toEqual(["core", undefined]);

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.batchId))).toEqual(new Set([body.batchId]));
  });
});

describe("fallbacks", () => {
  it("moves to the next provider after the first fails for good", async () => {
    const { app, calls, fetchMock } = await setup(async (url) =>
      url.includes("tavily")
        ? json({ detail: "bad key" }, 401)
        : json({ results: { web: [{ url: "https://y.com", title: "Y" }] } }),
    );
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", fallbacks: ["exa", "you"], query: "hello" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ provider: "you", ok: true });
    expect(
      body.fallback.tried.map((t: { provider: string; error: { type: string } }) => [
        t.provider,
        t.error.type,
      ]),
    ).toEqual([
      ["tavily", "auth_error"],
      ["exa", "not_configured"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.groupId)).size).toBe(1);
    expect(calls[0]?.groupId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the last failure when every provider fails", async () => {
    const { app } = await setup(async () => json({ detail: "nope" }, 400));
    close = () => app.close();
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", fallbacks: ["you"], query: "hello" },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body).toMatchObject({ provider: "you", ok: false });
    expect(body.fallback.tried.map((t: { provider: string }) => t.provider)).toEqual(["tavily"]);
  });
});

describe("outbound rate limits", () => {
  const limits = {
    PROVIDER_LIMITS: JSON.stringify({ tavily: { rpm: 2 }, you: { concurrency: 1 } }),
  };
  it("queues calls beyond the per-minute limit and reports the wait", async () => {
    const { app, fetchMock } = await setup(async () => json(tavilyBody), limits, {
      limitWindowMs: 300,
    });
    close = () => app.close();
    const bodies = (await Promise.all([search(app), search(app), search(app)])).map((r) =>
      r.json(),
    );
    expect(bodies.every((body) => body.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const waits = bodies.map((body) => body.timing.queuedMs).toSorted((a, b) => a - b);
    expect(waits[1]).toBeLessThan(100);
    expect(waits[2]).toBeGreaterThanOrEqual(250);
    const queued = bodies.find((body) => body.timing.queuedMs >= 250);
    expect(queued.retries.attempts[0].queuedMs).toBe(queued.timing.queuedMs);
    expect(queued.timing.totalMs).toBeGreaterThanOrEqual(queued.timing.queuedMs);
  });

  it("fails as throttled without calling upstream when the wait exceeds maxQueueMs", async () => {
    const { app, fetchMock } = await setup(async () => json(tavilyBody), limits, {
      limitWindowMs: 5000,
    });
    close = () => app.close();
    const responses = await Promise.all([search(app), search(app), search(app, { maxQueueMs: 0 })]);
    expect(responses.map((r) => r.statusCode).toSorted()).toEqual([200, 200, 429]);
    const throttled = responses.find((r) => r.statusCode === 429)!.json();
    expect(throttled.error).toMatchObject({ type: "throttled", upstreamStatus: null });
    expect(throttled.retries).toMatchObject({ count: 0, attempts: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("holds calls to the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const { app } = await setup(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return json({ results: { web: [] } });
    }, limits);
    close = () => app.close();
    await Promise.all([1, 2, 3].map(() => search(app, { provider: "you" })));
    expect(peak).toBe(1);
  });

  it("publishes limits, prices and balance support per provider", async () => {
    const { app } = await setup(async () => json(tavilyBody), {
      ...limits,
      PROVIDER_PRICING: JSON.stringify({ fastcrw: { perRequestUsd: 0.002 } }),
    });
    close = () => app.close();
    const list = (await app.inject({ method: "GET", url: "/v1/providers" })).json().providers;
    const byId = Object.fromEntries(list.map((p: { id: string }) => [p.id, p]));
    expect(byId.tavily).toMatchObject({
      limits: { rpm: 2 },
      pricing: { perCreditUsd: 0.008 },
      reportsBalance: true,
    });
    expect(byId.fastcrw).toMatchObject({
      limits: { rpm: 120, concurrency: 3 },
      pricing: { perRequestUsd: 0.002 },
    });
    expect(byId.brave).toMatchObject({ limits: {}, reportsBalance: false });
  });
});

describe("call log API", () => {
  it("serves logged calls and reports a missing store", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const made = (
      await app.inject({
        method: "POST",
        url: "/v1/search",
        payload: { provider: "tavily", query: "hello" },
      })
    ).json();
    const list = (await app.inject({ method: "GET", url: "/v1/calls?limit=10" })).json();
    expect(list.calls.map((call: { id: string }) => call.id)).toEqual([made.id]);
    expect((await app.inject({ method: "GET", url: `/v1/calls/${made.id}` })).json().id).toBe(
      made.id,
    );
    expect(
      (await app.inject({ method: "GET", url: `/v1/calls/${crypto.randomUUID()}` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/calls?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/usage" })).json()).toMatchObject({
      providers: [],
    });
    await app.close();

    const bare = await buildApp({ config: loadConfig({ LOG_LEVEL: "silent" }), env });
    close = () => bare.close();
    for (const url of ["/v1/calls", `/v1/calls/${made.id}`, "/v1/usage"]) {
      const response = await bare.inject({ method: "GET", url });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.type).toBe("store_unavailable");
    }
  });
});

describe("inbound rate limit", () => {
  it("limits requests per gateway API key", async () => {
    const { app } = await setup(async () => json(tavilyBody), {
      GATEWAY_API_KEYS: "k1,k2",
      INBOUND_RATE_LIMIT_RPM: "2",
    });
    close = () => app.close();
    const get = (key: string) =>
      app.inject({
        method: "GET",
        url: "/v1/providers",
        headers: { authorization: `Bearer ${key}` },
      });
    expect([(await get("k1")).statusCode, (await get("k1")).statusCode]).toEqual([200, 200]);
    const limited = await get("k1");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.type).toBe("rate_limited");
    expect((await get("k2")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("GET /v1/status", () => {
  it("leaves health alone when the provider rejects the caller's request", async () => {
    const { app } = await setup(async () => json({ detail: "unknown field" }, 400));
    close = () => app.close();
    expect((await search(app)).json().error.type).toBe("upstream_invalid_request");
    const body = (await app.inject({ method: "GET", url: "/v1/status" })).json();
    expect(body.providers.find((p: { id: string }) => p.id === "tavily")).toMatchObject({
      status: "unknown",
      recentCalls: 0,
    });
  });

  it("derives provider health from traffic", async () => {
    let fail = false;
    const { app } = await setup(async () =>
      fail ? json({ detail: "bad" }, 500) : json(tavilyBody),
    );
    close = () => app.close();
    const once = () => search(app);
    const tavily = async () => {
      const body = (await app.inject({ method: "GET", url: "/v1/status" })).json();
      return { body, tavily: body.providers.find((p: { id: string }) => p.id === "tavily") };
    };

    expect((await tavily()).tavily).toMatchObject({
      status: "unknown",
      configured: true,
      recentCalls: 0,
    });
    await once();
    expect((await tavily()).tavily).toMatchObject({
      status: "healthy",
      successRate: 1,
      lastError: null,
    });

    fail = true;
    await once();
    const degraded = await tavily();
    expect(degraded.body).toMatchObject({ status: "ok", store: "ok" });
    expect(degraded.tavily).toMatchObject({
      status: "degraded",
      consecutiveFailures: 1,
      successRate: 0.5,
      lastError: { type: "upstream_error" },
    });
    await once();
    await once();
    const down = await tavily();
    expect(down.tavily.status).toBe("down");
    expect(down.body.status).toBe("degraded");

    fail = false;
    await once();
    expect((await tavily()).tavily).toMatchObject({ status: "degraded", consecutiveFailures: 0 });
  });

  it("probes every configured provider on request", async () => {
    const { app, fetchMock } = await setup(async (url) =>
      url.includes("tavily") ? json(tavilyBody) : json({ results: { web: [] } }),
    );
    close = () => app.close();
    await app.inject({ method: "GET", url: "/v1/status" });
    expect(fetchMock).not.toHaveBeenCalled();
    const body = (await app.inject({ method: "GET", url: "/v1/status?probe=true" })).json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const statuses = Object.fromEntries(
      body.providers.map((p: { id: string; status: string }) => [p.id, p.status]),
    );
    expect(statuses).toMatchObject({ tavily: "healthy", you: "healthy", exa: "unknown" });
  });
});

describe("agent documentation", () => {
  it("is public and generated from the live provider registry", async () => {
    const { app } = await setup(async () => json(tavilyBody), { GATEWAY_API_KEYS: "k1" });
    close = () => app.close();
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: { host: "search.test" } });

    const index = await get("/llms.txt");
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/markdown");
    expect(index.body).toMatch(/^# toolcallstack-search\n\n> /);
    expect(index.body).toContain("http://search.test/llms-full.txt");
    expect(index.body).toContain(
      "[Tavily](http://search.test/docs/providers/tavily.md): `tavily`, configured",
    );
    expect(index.body).toContain("`exa`, not configured");

    const full = (await get("/llms-full.txt")).body;
    for (const text of [
      "## Search request",
      "`maxQueueMs`",
      "`throttled`",
      "| `brave` | no | 20 | yes |",
    ]) {
      expect(full).toContain(text);
    }

    const page = await get("/docs/providers/you.md");
    expect(page.headers["content-type"]).toContain("text/markdown");
    expect(page.body).toContain("# You.com (`you`)");
    expect(page.body).toContain(
      'Not supported (dropped with a warning): `topic: "news"`, `freshness: "hour"`',
    );
    expect(page.body).toContain("knowledge");
    expect((await get("/docs/providers/nope.md")).statusCode).toBe(404);

    const spec = (await get("/openapi.json")).json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/v1/search",
        "/v1/status",
        "/v1/providers/{id}",
        "/v1/calls",
        "/v1/usage",
      ]),
    );
    expect(Object.keys(spec.paths)).not.toContain("/llms.txt");
    // Swagger UI still works next to the provider pages under /docs.
    expect((await get("/docs/json")).statusCode).toBe(200);
  });

  it("serves JSON Schemas and tool definitions", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const list = (await app.inject({ method: "GET", url: "/schemas" })).json().schemas;
    expect(list.map((s: { name: string }) => s.name)).toContain("search-request");

    const request = (
      await app.inject({ method: "GET", url: "/schemas/search-request.json" })
    ).json();
    expect(request.required).toEqual(expect.arrayContaining(["query", "provider"]));
    expect(request.required).not.toContain("maxResults");
    expect(request.properties.freshness.enum).toEqual(["hour", "day", "week", "month", "year"]);
    const response = (await app.inject({ method: "GET", url: "/schemas/search-response" })).json();
    expect(Object.keys(response.properties)).toEqual(
      expect.arrayContaining(["results", "timing", "retries", "usage", "fallback"]),
    );
    expect((await app.inject({ method: "GET", url: "/schemas/nope.json" })).statusCode).toBe(404);

    const tools = (await app.inject({ method: "GET", url: "/tools.json" })).json();
    expect(tools.anthropic[0]).toMatchObject({ name: "web_search" });
    expect(tools.anthropic[0].description).toContain("available: tavily, you");
    expect(tools.anthropic[0].input_schema.required).toEqual(
      expect.arrayContaining(["query", "provider"]),
    );
    expect(tools.anthropic[0].input_schema.properties).not.toHaveProperty("maxRetries");
    expect(tools.openai[0].function.parameters).toEqual(tools.anthropic[0].input_schema);
    expect(tools.call.url).toMatch(/\/v1\/search$/);
  });

  it("describes one provider as JSON", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const exa = (await app.inject({ method: "GET", url: "/v1/providers/exa" })).json();
    expect(exa).toMatchObject({
      id: "exa",
      configured: false,
      envVar: "EXA_API_KEY",
      reportsBalance: false,
      balanceEnvVar: "EXA_SERVICE_KEY",
    });
    expect(exa.notes.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/v1/providers/nope" })).statusCode).toBe(404);
  });
});

const budgets = (value: object) => ({ PROVIDER_BUDGETS: JSON.stringify(value) });

describe("budgets", () => {
  it("refuses calls once the daily call cap is used, without calling upstream", async () => {
    const { app, fetchMock } = await setup(
      async () => json(tavilyBody),
      budgets({ tavily: { daily: { calls: 2 } } }),
    );
    close = () => app.close();
    expect((await search(app)).statusCode).toBe(200);
    expect((await search(app)).statusCode).toBe(200);
    const refused = await search(app);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      ok: false,
      error: { type: "budget_exceeded", upstreamStatus: null },
      retries: { count: 0, attempts: [] },
    });
    expect(refused.json().error.message).toContain(
      "daily budget for 'tavily' is used up (2 of 2 calls)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const info = (await app.inject({ method: "GET", url: "/v1/providers/tavily" })).json();
    expect(info.budget).toMatchObject({
      daily: { caps: { calls: 2 }, spent: { calls: 2, credits: 2, usd: 0.016 } },
      monthly: null,
    });
    expect(info.budget.blocked).toContain("used up");
    const status = (await app.inject({ method: "GET", url: "/v1/status" })).json();
    const tavily = status.providers.find((p: { id: string }) => p.id === "tavily");
    // A used-up budget is the gateway's choice, not a sign the provider is unhealthy.
    expect(tavily).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    expect(tavily.budgetBlocked).toContain("used up");
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain(
      'toolcallstack_search_budget_spent{provider="tavily",period="daily",unit="calls"} 2',
    );
  });

  it("caps dollars and credits, counts only successful calls, and never blocks other providers", async () => {
    let fail = true;
    const { app } = await setup(
      async (url) =>
        url.includes("ydc-index")
          ? json({ results: { web: [] } })
          : fail
            ? json({ detail: "bad" }, 400)
            : json(tavilyBody),
      budgets({ tavily: { monthly: { usd: 0.01 } }, you: { daily: { credits: 5 } } }),
    );
    close = () => app.close();
    // Failed calls are not billed, so they do not use the budget.
    expect((await search(app)).json().error.type).toBe("upstream_invalid_request");
    expect((await search(app)).json().error.type).toBe("upstream_invalid_request");
    fail = false;
    expect((await search(app)).json().ok).toBe(true);
    // 0.008 spent is under the 0.01 cap, so one more call is allowed and takes it over.
    expect((await search(app)).json().ok).toBe(true);
    expect((await search(app)).json().error.type).toBe("budget_exceeded");
    // You.com reports no credits, so its credit cap is never reached.
    for (let i = 0; i < 3; i++)
      expect((await search(app, { provider: "you" })).json().ok).toBe(true);
  });

  it("starts from the spend already in the call log", async () => {
    seededSpend = [
      {
        provider: "tavily",
        day: { calls: 1, usd: 0.008, credits: 1 },
        month: { calls: 40, usd: 0.32, credits: 40 },
      },
    ];
    const { app, fetchMock } = await setup(
      async () => json(tavilyBody),
      budgets({ tavily: { daily: { calls: 2 }, monthly: { credits: 41 } } }),
    );
    close = () => app.close();
    await app.ready();
    expect((await search(app)).json().ok).toBe(true);
    const refused = (await search(app)).json();
    expect(refused.error.type).toBe("budget_exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back past a provider whose budget is used up", async () => {
    const { app } = await setup(
      async (url) => (url.includes("tavily") ? json(tavilyBody) : json({ results: { web: [] } })),
      budgets({ tavily: { daily: { calls: 0 } } }),
    );
    close = () => app.close();
    const body = (await search(app, { fallbacks: ["you"] })).json();
    expect(body).toMatchObject({ provider: "you", ok: true });
    expect(body.fallback.tried).toMatchObject([
      { provider: "tavily", error: { type: "budget_exceeded" } },
    ]);
  });

  it("rejects malformed budget configuration at start", () => {
    expect(() => loadConfig({ PROVIDER_BUDGETS: "{not json" })).toThrow(/invalid JSON/);
    expect(() => loadConfig({ PROVIDER_BUDGETS: '{"tavily":{"daily":{"calls":-1}}}' })).toThrow();
  });
});

describe("clients", () => {
  it("attributes calls to the named key that made them", async () => {
    const { app, calls } = await setup(async () => json(tavilyBody), {
      GATEWAY_API_KEYS: "alice:sk-alice, bob:sk:with:colons, bare-token",
    });
    close = () => app.close();
    const as = (token: string) =>
      app.inject({
        method: "POST",
        url: "/v1/search",
        headers: { authorization: `Bearer ${token}` },
        payload: { provider: "tavily", query: "hello" },
      });
    expect((await as("sk-alice")).statusCode).toBe(200);
    expect((await as("sk:with:colons")).statusCode).toBe(200);
    expect((await as("bare-token")).statusCode).toBe(200);
    expect((await as("alice:sk-alice")).statusCode).toBe(401);
    expect((await as("sk-alic")).statusCode).toBe(401);
    expect((await as("nope")).json()).toEqual({
      error: { type: "unauthorized", message: "invalid authorization header" },
    });
    expect(calls.map((call) => call.client)).toEqual([
      "alice",
      "bob",
      expect.stringMatching(/^key-[0-9a-f]{8}$/),
    ]);
  });

  it("records no client when auth is off, and passes it through batch calls", async () => {
    const open = await setup(async () => json(tavilyBody));
    close = () => open.app.close();
    await search(open.app);
    expect(open.calls[0]?.client).toBeNull();
    await open.app.close();

    const { app, calls } = await setup(async () => json(tavilyBody), { GATEWAY_API_KEYS: "ci:k" });
    close = () => app.close();
    await app.inject({
      method: "POST",
      url: "/v1/search/batch",
      headers: { authorization: "Bearer k" },
      payload: { providers: ["tavily", "tavily"], query: "hello" },
    });
    expect(calls.map((call) => call.client)).toEqual(["ci", "ci"]);
  });
});

describe("redaction", () => {
  it("sends secrets in options upstream but keeps them out of the call log", async () => {
    const { app, calls, fetchMock } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    await search(app, {
      options: {
        llmApiKey: "sk-live-123",
        nested: { Authorization: "Bearer abc", access_token: "tok", max_tokens: 500, note: "fine" },
        list: [{ client_secret: "shh", keywords: "kept" }],
      },
    });
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(sent).toMatchObject({ llmApiKey: "sk-live-123", nested: { access_token: "tok" } });
    expect(calls[0]?.params.options).toEqual({
      llmApiKey: "[redacted]",
      nested: {
        Authorization: "[redacted]",
        access_token: "[redacted]",
        max_tokens: 500,
        note: "fine",
      },
      list: [{ client_secret: "[redacted]", keywords: "kept" }],
    });
    // Neither the provider key nor a caller secret is anywhere in what gets stored.
    const stored = JSON.stringify(calls[0]);
    for (const secret of ["tvly-test", "sk-live-123", "Bearer abc", "shh"]) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe("dashboard", () => {
  it("serves the built app under /ui with a fallback for client-side routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toolcallstack-search-ui-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    const app = await buildApp({ config: loadConfig({ LOG_LEVEL: "silent" }), env, uiDir: dir });
    close = () => app.close();

    const root = await app.inject({ method: "GET", url: "/" });
    expect([root.statusCode, root.headers.location]).toEqual([302, "/ui/"]);
    for (const url of ["/ui/", "/ui/calls", "/ui/usage?x=1"]) {
      const page = await app.inject({ method: "GET", url });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("<title>app</title>");
    }
    const asset = await app.inject({ method: "GET", url: "/ui/assets/app.js" });
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.body).toBe("console.log(1)");
    // A build made after start is picked up, and a missing asset is a 404 rather than the page.
    writeFileSync(join(dir, "assets", "later.js"), "console.log(2)");
    expect((await app.inject({ method: "GET", url: "/ui/assets/later.js" })).body).toBe(
      "console.log(2)",
    );
    expect((await app.inject({ method: "GET", url: "/ui/assets/gone.js" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
  });

  it("is simply absent when there is no build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toolcallstack-search-ui-"));
    const app = await buildApp({ config: loadConfig({ LOG_LEVEL: "silent" }), env, uiDir: dir });
    close = () => app.close();
    expect((await app.inject({ method: "GET", url: "/ui/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("auth", () => {
  it("requires a bearer token when keys are configured", async () => {
    const { app } = await setup(async () => json(tavilyBody), { GATEWAY_API_KEYS: "k1, k2" });
    close = () => app.close();
    const request = (authorization?: string) =>
      app.inject({
        method: "GET",
        url: "/v1/providers",
        headers: authorization ? { authorization } : {},
      });
    expect((await request()).statusCode).toBe(401);
    expect((await request("Bearer wrong")).statusCode).toBe(401);
    expect((await request("Bearer k2")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
  });
});

describe("introspection", () => {
  it("lists providers with their configured state", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const body = (await app.inject({ method: "GET", url: "/v1/providers" })).json();
    const configured = body.providers
      .filter((p: { configured: boolean }) => p.configured)
      .map((p: { id: string }) => p.id);
    expect(configured).toEqual(["tavily", "you"]);
  });

  it("exposes call metrics and an OpenAPI document", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { provider: "tavily", query: "hello" },
    });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain(
      'toolcallstack_search_upstream_calls_total{provider="tavily",outcome="ok"} 1',
    );
    expect(metrics.body).toContain(
      'toolcallstack_search_cost_usd_total{provider="tavily",source="estimated"} 0.008',
    );
    expect(metrics.body).toContain('toolcallstack_search_queue_depth{provider="tavily"} 0');
    expect(metrics.body).toContain("http_request_duration_seconds_bucket");
    expect(metrics.body).toContain("nodejs_eventloop_lag_seconds");
    const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/v1/providers", "/v1/search", "/v1/search/batch"]),
    );
  });
});

describe("minRemaining budgets", () => {
  it("hold to the account balance without a database", async () => {
    const app = await buildApp({
      config: loadConfig({
        LOG_LEVEL: "silent",
        BALANCE_POLL_SECONDS: "60",
        PROVIDER_BUDGETS: '{"tavily":{"minRemaining":100}}',
      }),
      store: null,
      env,
      transport: async (request) => ({
        status: 200,
        headers: {},
        phases,
        // 1000 credits, 950 used: 50 left, under the floor of 100.
        text: JSON.stringify(
          request.url.endsWith("/usage") ? { key: { usage: 950, limit: 1000 } } : tavilyBody,
        ),
      }),
    });
    close = () => app.close();
    await app.ready();
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        payload: { provider: "tavily", query: "hello" },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.type).toBe("budget_exceeded");
    });
  });
});

describe("answers the gateway cannot read", () => {
  it("warns and counts it when a successful answer has content but no readable result", async () => {
    // As if Tavily renamed `results` and `url`.
    const { app } = await setup(async () => json({ items: [{ link: "https://a.com/1" }] }));
    close = () => app.close();
    const body = (await search(app)).json();
    expect(body).toMatchObject({ ok: true, results: [] });
    expect(body.warnings).toContain(
      "the provider answered with content but no result could be read from it; its response format may have changed",
    );
    const metrics = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(metrics).toContain(
      'toolcallstack_search_parse_anomalies_total{provider="tavily",kind="unreadable"} 1',
    );
  });

  it("stays quiet about a genuinely empty answer", async () => {
    const { app } = await setup(async () => json({ query: "hello", results: [] }));
    close = () => app.close();
    expect((await search(app)).json()).toMatchObject({ ok: true, results: [], warnings: [] });
  });
});

describe("timing metrics", () => {
  it("records whole calls, every phase and dated results", async () => {
    const { app } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    await search(app);
    const metrics = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(metrics).toContain(
      'toolcallstack_search_call_duration_seconds_count{provider="tavily",outcome="ok"} 1',
    );
    for (const phase of ["dns", "connect", "tls", "ttfb", "download"]) {
      expect(metrics).toContain(
        `toolcallstack_search_upstream_phase_seconds_count{provider="tavily",phase="${phase}"} 1`,
      );
    }
    expect(metrics).toContain(
      'toolcallstack_search_results_total{provider="tavily",dated="false"} 2',
    );
  });
});

describe("request checks", () => {
  it.each([
    [{ startDate: "2026-02-31" }, "not a calendar date"],
    [{ startDate: "2026-03-10", endDate: "2026-03-01" }, "endDate is before startDate"],
  ])("refuses %j before anything is sent", async (dates, message) => {
    const { app, fetchMock } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    for (const url of ["/v1/search", "/v1/search/batch"]) {
      const response = await app.inject({
        method: "POST",
        url,
        payload: { provider: "tavily", providers: ["tavily"], query: "hello", ...dates },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(message);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives every result a canonical URL", async () => {
    const { app } = await setup(async () =>
      json({ results: [{ url: "http://www.a.com/1/?utm_source=x", title: "One" }] }),
    );
    close = () => app.close();
    const [result] = (await search(app)).json().results;
    expect(result).toMatchObject({
      url: "http://www.a.com/1/?utm_source=x",
      canonicalUrl: "https://a.com/1",
    });
  });
});

describe("cache", () => {
  it("answers an identical call from the cache: nothing sent, nothing billed, health untouched", async () => {
    const { app, fetchMock, calls } = await setup(async () => json(tavilyBody));
    close = () => app.close();
    const first = (await search(app, { cacheTtlSeconds: 60 })).json();
    expect(first).toMatchObject({ ok: true, cache: { hit: false } });
    const second = (await search(app, { cacheTtlSeconds: 60, timeoutMs: 5000 })).json();
    expect(second).toMatchObject({
      ok: true,
      results: first.results,
      usage: { costUsd: 0, costSource: "cache" },
      cache: { hit: true, sourceCallId: first.id },
      retries: { attempts: [] },
    });
    expect(second.id).not.toBe(first.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.response.cache?.hit)).toEqual([false, true]);
    const status = (await app.inject({ method: "GET", url: "/v1/status" })).json();
    expect(status.providers.find((p: { id: string }) => p.id === "tavily").recentCalls).toBe(1);
    // Without cacheTtlSeconds, and with the default of 0, nothing is reused.
    expect((await search(app)).json().cache).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends identical calls in flight upstream once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { app, fetchMock } = await setup(async () => {
      await gate;
      return json(tavilyBody);
    });
    close = () => app.close();
    const both = Promise.all([
      search(app, { cacheTtlSeconds: 60 }),
      search(app, { cacheTtlSeconds: 60 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const hits = (await both).map((reply) => reply.json().cache.hit).toSorted();
    expect(hits).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const { app, fetchMock } = await setup(async () => json({ detail: "bad" }, 400));
    close = () => app.close();
    await search(app, { cacheTtlSeconds: 60 });
    await search(app, { cacheTtlSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
