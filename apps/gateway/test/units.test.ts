import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollBalances } from "../src/balances.ts";
import { estimateCost, withCost } from "../src/cost.ts";
import { ProviderLimiter, QueueTimeoutError } from "../src/limiter.ts";
import { createMetrics } from "../src/metrics.ts";
import { providersById } from "../src/providers/index.ts";
import { spentBetween, type BalanceSnapshot, type Store } from "../src/store.ts";
import { createTransport } from "../src/transport.ts";
import { VERSION } from "../src/version.ts";

describe("cost", () => {
  it("prices by reported credits when a credit price is known", () => {
    expect(estimateCost({ perCreditUsd: 0.008 }, 2, 10)).toBe(0.016);
  });

  it("prices per request, charging results beyond the included ones", () => {
    const pricing = { perRequestUsd: 0.007, includedResults: 10, perExtraResultUsd: 0.001 };
    expect(estimateCost(pricing, undefined, 10)).toBe(0.007);
    expect(estimateCost(pricing, undefined, 25)).toBe(0.022);
    expect(estimateCost({ perRequestUsd: 0.005 }, undefined, 100)).toBe(0.005);
  });

  it("knows no price without a table entry", () => {
    expect(estimateCost(undefined, 3, 10)).toBeNull();
    expect(estimateCost({ perCreditUsd: 0.01 }, undefined, 10)).toBeNull();
  });

  it("says which figure to trust", () => {
    expect(withCost({ costUsd: 0.007 }, { perRequestUsd: 0.005 }, 10)).toEqual({
      costUsd: 0.007,
      estimatedCostUsd: 0.005,
      costSource: "reported",
    });
    expect(withCost({ credits: 1 }, { perCreditUsd: 0.008 }, 10)).toEqual({
      credits: 1,
      estimatedCostUsd: 0.008,
      costSource: "estimated",
    });
    expect(withCost({}, undefined, 10)).toEqual({ costSource: "unknown" });
  });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ProviderLimiter", () => {
  it("runs unlimited providers at once with no wait", async () => {
    const limiter = new ProviderLimiter({ a: {} });
    expect(await limiter.run("a", 0, async (queuedMs) => queuedMs)).toBe(0);
    expect(await limiter.run("unknown", 0, async (queuedMs) => queuedMs)).toBe(0);
  });

  it("starts at most rpm tasks per rolling window, in order", async () => {
    const limiter = new ProviderLimiter({ a: { rpm: 2 } }, 200);
    const started = performance.now();
    const order: number[] = [];
    const starts = await Promise.all(
      [0, 1, 2, 3].map((n) =>
        limiter.run("a", 5000, async () => {
          order.push(n);
          return performance.now() - started;
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
    expect(starts[1]).toBeLessThan(100);
    expect(starts[2]).toBeGreaterThanOrEqual(190);
  });

  it("limits tasks in flight and reports queue depth", async () => {
    const limiter = new ProviderLimiter({ a: { concurrency: 1 } });
    const first = limiter.run("a", 5000, () => wait(60));
    const second = limiter.run("a", 5000, async (queuedMs) => queuedMs);
    await wait(10);
    expect(limiter.depth("a")).toBe(1);
    await first;
    expect(await second).toBeGreaterThanOrEqual(40);
    expect(limiter.depth("a")).toBe(0);
  });

  it("gives up after maxQueueMs without running the task", async () => {
    const limiter = new ProviderLimiter({ a: { concurrency: 1 } });
    const first = limiter.run("a", 5000, () => wait(80));
    let ran = false;
    await expect(
      limiter.run("a", 20, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(QueueTimeoutError);
    await first;
    await wait(10);
    expect(ran).toBe(false);
    // The slot is still usable afterwards.
    expect(await limiter.run("a", 20, async () => "ok")).toBe("ok");
  });

  it("passes task errors through", async () => {
    const limiter = new ProviderLimiter({ a: { concurrency: 1 } });
    await expect(
      limiter.run("a", 100, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("transport", () => {
  let server: http.Server;
  let base: string;
  const transport = createTransport();

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === "/slow") return void setTimeout(() => response.end("late"), 500);
      if (request.url === "/gzip") {
        response.writeHead(200, { "content-encoding": "gzip", "x-test": "1" });
        return void response.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
      }
      if (request.url === "/drip") {
        response.writeHead(200);
        response.write("a");
        return void setTimeout(() => response.end("b"), 80);
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.writeHead(request.url === "/missing" ? 404 : 200, { "retry-after": "2" });
        response.end(
          JSON.stringify({ method: request.method, body, type: request.headers["content-type"] }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("sends the body and returns status, headers, text and phases", async () => {
    const response = await transport({
      method: "POST",
      url: `${base}/echo`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "héllo" }),
      timeoutMs: 2000,
    });
    expect(response.status).toBe(200);
    expect(response.headers["retry-after"]).toBe("2");
    expect(JSON.parse(response.text)).toEqual({
      method: "POST",
      body: '{"q":"héllo"}',
      type: "application/json",
    });
    expect(response.phases.connectionReused).toBe(false);
    expect(response.phases.connectMs).toBeGreaterThanOrEqual(0);
    expect(response.phases.tlsMs).toBeNull();
    expect(response.phases.ttfbMs).toBeGreaterThan(0);
  });

  it("reuses the connection and then reports no connection phases", async () => {
    const response = await transport({
      method: "GET",
      url: `${base}/again`,
      headers: {},
      timeoutMs: 2000,
    });
    expect(response.phases).toMatchObject({
      connectionReused: true,
      dnsMs: null,
      connectMs: null,
      tlsMs: null,
    });
  });

  it("returns error statuses instead of throwing", async () => {
    const response = await transport({
      method: "GET",
      url: `${base}/missing`,
      headers: {},
      timeoutMs: 2000,
    });
    expect(response.status).toBe(404);
  });

  it("decompresses gzip bodies", async () => {
    const response = await transport({
      method: "GET",
      url: `${base}/gzip`,
      headers: {},
      timeoutMs: 2000,
    });
    expect(JSON.parse(response.text)).toEqual({ zipped: true });
    expect(response.headers["x-test"]).toBe("1");
  });

  it("separates time to first byte from download", async () => {
    const response = await transport({
      method: "GET",
      url: `${base}/drip`,
      headers: {},
      timeoutMs: 2000,
    });
    expect(response.text).toBe("ab");
    expect(response.phases.downloadMs).toBeGreaterThanOrEqual(60);
    expect(response.phases.ttfbMs).toBeLessThan(60);
  });

  it("times out with a TimeoutError", async () => {
    const started = performance.now();
    await expect(
      transport({ method: "GET", url: `${base}/slow`, headers: {}, timeoutMs: 80 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("rejects when nothing is listening", async () => {
    await expect(
      transport({ method: "GET", url: "http://127.0.0.1:1/", headers: {}, timeoutMs: 2000 }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("balances", () => {
  it.each([
    [
      "tavily",
      { key: { usage: 9, limit: null }, account: { plan_limit: 1000 } },
      { unit: "credits", used: 9, quota: 1000, remaining: 991 },
    ],
    [
      "firecrawl",
      { success: true, data: { remainingCredits: 1007, planCredits: 1000 } },
      { unit: "credits", remaining: 1007, used: null, quota: 1000 },
    ],
    [
      "you",
      { data: { type: "account", attributes: { balance: 994.0 } } },
      { unit: "usd", remaining: 9.94, used: null, quota: null },
    ],
    [
      "fastcrw",
      { success: true, totalCreditsAvailable: 472, monthlyCreditAllowance: 500 },
      { unit: "credits", remaining: 472, used: null, quota: 500 },
    ],
    [
      "exa",
      { id: "key_1", total_cost_usd: 0.063, cost_breakdown: [] },
      { unit: "usd", used: 0.063, remaining: null, quota: null },
    ],
    [
      "parallel",
      {
        org_id: "o",
        credit_balance_cents: 1950,
        pending_debit_balance_cents: 0,
        will_invoice: false,
      },
      { unit: "usd", remaining: 19.5, used: null, quota: null },
    ],
  ])("parses the %s balance response", (id, body, expected) => {
    const balance = providersById.get(id)!.balance!;
    expect(balance.parse(body)).toEqual(expected);
    expect(balance.parse({})).toBeNull();
  });

  it("reads Exa and Parallel accounts with their separate credentials", () => {
    const ctx = {
      apiKey: "search key",
      credential: "account-cred",
      now: new Date("2026-11-09T12:00:00Z"),
    };
    const exa = providersById.get("exa")!.balance!.request(ctx);
    expect(exa.url).toBe(
      "https://admin-api.exa.ai/team-management/api-keys/search%20key/usage?start_date=2026-11-01",
    );
    expect(exa.headers).toEqual({ "x-api-key": "account-cred" });
    const parallel = providersById.get("parallel")!.balance!;
    expect(parallel.request(ctx).headers).toEqual({ Authorization: "Bearer account-cred" });
    expect(parallel.parse({ credit_balance_cents: 0, will_invoice: true })).toBeNull();
  });

  it("snapshots every configured provider that reports a balance", async () => {
    const saved: BalanceSnapshot[] = [];
    const requested: string[] = [];
    const metrics = createMetrics();
    const count = await pollBalances({
      env: {
        TAVILY_API_KEY: "t",
        YOU_API_KEY: "y",
        BRAVE_API_KEY: "b",
        FIRECRAWL_API_KEY: "f",
        // No EXA_SERVICE_KEY, so Exa's account cannot be read and is skipped.
        EXA_API_KEY: "e",
      },
      store: { saveBalance: async (snapshot) => void saved.push(snapshot) } as Store,
      metrics,
      log: { warn: () => {} } as never,
      transport: async (request) => {
        requested.push(request.url);
        const phases = {
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: 1,
          downloadMs: 1,
          connectionReused: true,
        };
        if (request.url.includes("tavily")) {
          expect(request.headers.Authorization).toBe("Bearer t");
          return {
            status: 200,
            headers: {},
            phases,
            text: JSON.stringify({ key: { usage: 9, limit: 1000 } }),
          };
        }
        if (request.url.includes("you.com")) {
          return {
            status: 200,
            headers: {},
            phases,
            text: JSON.stringify({ data: { attributes: { balance: 994 } } }),
          };
        }
        return { status: 500, headers: {}, phases, text: "down" };
      },
    });
    // Brave has no balance endpoint; Firecrawl's failed and is skipped, not fatal.
    expect(count).toBe(2);
    expect(requested).toHaveLength(3);
    expect(saved.map((s) => [s.provider, s.unit, s.remaining]).toSorted()).toEqual([
      ["tavily", "credits", 991],
      ["you", "usd", 9.94],
    ]);
    expect(saved[0]?.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(await metrics.registry.metrics()).toContain(
      'toolcallstack_search_balance{provider="you",unit="usd"} 9.94',
    );
  });

  it("computes spend from whichever counter is available", () => {
    expect(spentBetween({ used: 9, remaining: 991 }, { used: 15, remaining: 985 })).toBe(6);
    expect(spentBetween({ used: null, remaining: 9.94 }, { used: null, remaining: 9.9 })).toBe(
      0.04,
    );
    expect(spentBetween({ used: null, remaining: null }, { used: 1, remaining: null })).toBeNull();
    // A top-up or a new billing period is not spend.
    expect(spentBetween({ used: 40, remaining: null }, { used: 2, remaining: null })).toBeNull();
    expect(spentBetween({ used: null, remaining: 5 }, { used: null, remaining: 25 })).toBeNull();
  });
});

describe("version", () => {
  it("matches every package.json", () => {
    for (const path of [
      "../package.json",
      "../../dashboard/package.json",
      "../../../package.json",
    ]) {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
      expect(pkg.version, path).toBe(VERSION);
    }
  });
});
