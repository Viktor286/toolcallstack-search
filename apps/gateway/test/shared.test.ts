import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { QueueTimeoutError } from "../src/limiter.ts";
import { PostgresLimiter } from "../src/shared-limiter.ts";
import { createPostgresStore, migrate } from "../src/store.ts";

// Needs a disposable Postgres database: TEST_DATABASE_URL=postgres://localhost/toolcallstack_search_test
const databaseUrl = process.env.TEST_DATABASE_URL;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One gateway instance with shared state on, as a second process would be started. */
const start = (store: ReturnType<typeof createPostgresStore>) =>
  buildApp({
    config: loadConfig({
      LOG_LEVEL: "silent",
      SHARED_STATE: "true",
      BALANCE_POLL_SECONDS: "0",
      PROVIDER_BUDGETS: '{"demo-a":{"daily":{"calls":2}}}',
    }),
    env: {},
    store,
    sql: store.sql,
    sleep: async () => {},
  });

describe.skipIf(!databaseUrl)("state shared between instances", () => {
  // Two stores stand for two gateway processes on one database.
  let first: ReturnType<typeof createPostgresStore>;
  let second: ReturnType<typeof createPostgresStore>;

  beforeAll(async () => {
    first = createPostgresStore(databaseUrl!, { storeRaw: false });
    second = createPostgresStore(databaseUrl!, { storeRaw: false });
    await migrate(first.sql);
  });
  beforeEach(async () => {
    await first.sql`TRUNCATE gateway.limiter_slots, gateway.search_calls`;
  });
  afterAll(async () => {
    await first?.close();
    await second?.close();
  });

  it("counts one rolling window across instances", async () => {
    const limits = { p: { rpm: 2 } };
    const a = new PostgresLimiter(first.sql, limits, 400);
    const b = new PostgresLimiter(second.sql, limits, 400);
    const waits = await Promise.all([
      a.run("p", 5000, async (queuedMs) => queuedMs),
      b.run("p", 5000, async (queuedMs) => queuedMs),
    ]);
    expect(Math.max(...waits)).toBeLessThan(300);
    // The window is full now, whichever instance asks.
    expect(await a.run("p", 5000, async (queuedMs) => queuedMs)).toBeGreaterThan(200);
  });

  it("allows only the shared number of requests in flight", async () => {
    const limits = { p: { concurrency: 1 } };
    const a = new PostgresLimiter(first.sql, limits);
    const b = new PostgresLimiter(second.sql, limits);
    let running = 0;
    let most = 0;
    const task = async () => {
      most = Math.max(most, ++running);
      await sleep(60);
      running -= 1;
    };
    await Promise.all([a.run("p", 5000, task), b.run("p", 5000, task), a.run("p", 5000, task)]);
    expect(most).toBe(1);
    expect(a.depth("p")).toBe(0);
  });

  it("gives up after maxQueueMs without running the task", async () => {
    const limits = { p: { rpm: 1 } };
    const a = new PostgresLimiter(first.sql, limits, 60_000);
    const b = new PostgresLimiter(second.sql, limits, 60_000);
    await a.run("p", 0, async () => {});
    let ran = false;
    await expect(b.run("p", 120, async () => void (ran = true))).rejects.toBeInstanceOf(
      QueueTimeoutError,
    );
    expect(ran).toBe(false);
  });

  it("ignores a slot whose holder died, and providers without limits", async () => {
    await first.sql`
      INSERT INTO gateway.limiter_slots (provider, instance, acquired_at)
      VALUES ('p', 'dead', now() - interval '10 minutes')`;
    const a = new PostgresLimiter(first.sql, { p: { concurrency: 1 } });
    expect(await a.run("p", 0, async () => "ran")).toBe("ran");
    expect(await a.run("unlimited", 0, async (queuedMs) => queuedMs)).toBe(0);
  });

  it("shares budgets and provider health through the call log", async () => {
    // Each app closes its own store, so these two get their own.
    const one = await start(createPostgresStore(databaseUrl!, { storeRaw: false }));
    const two = await start(createPostgresStore(databaseUrl!, { storeRaw: false }));
    try {
      const search = (
        app: Awaited<ReturnType<typeof start>>,
        options: Record<string, unknown> = {},
      ) =>
        app.inject({
          method: "POST",
          url: "/v1/search",
          payload: {
            provider: "demo-a",
            query: "x",
            maxRetries: 0,
            options: { latencyMs: 1, ...options },
          },
        });
      // A failed call is not billed, so it does not count toward the budget of two.
      await search(one, { status: 503 });
      expect((await search(one)).statusCode).toBe(200);
      expect((await search(one)).statusCode).toBe(200);

      // The call log is written off the request path.
      await expect
        .poll(async () => (await first.sql`SELECT 1 FROM gateway.search_calls`).length)
        .toBe(3);
      await two.services.syncShared!();

      const refused = await search(two);
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.type).toBe("budget_exceeded");
      const status = (await two.inject("/v1/status")).json();
      expect(status.providers.find((p: { id: string }) => p.id === "demo-a")).toMatchObject({
        status: "degraded",
        recentCalls: 3,
        consecutiveFailures: 0,
        lastError: { type: "upstream_error" },
      });
    } finally {
      await one.close();
      await two.close();
    }
  });

  it("refuses to start without a database", async () => {
    await expect(
      buildApp({ config: loadConfig({ LOG_LEVEL: "silent", SHARED_STATE: "true" }), env: {} }),
    ).rejects.toThrow(/DATABASE_URL/);
  });
});
