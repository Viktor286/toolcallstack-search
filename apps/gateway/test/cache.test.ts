import { describe, expect, it } from "vitest";
import { cacheKey, ResponseCache, type Claim } from "../src/cache.ts";
import { searchParamsSchema } from "../src/schema.ts";

const params = (extra: object = {}) => searchParamsSchema.parse({ query: "q", ...extra });
const answer = (callId: string, hasRaw = false) => ({
  callId,
  results: [],
  warnings: [],
  upstream: { status: 200, requestId: null },
  hasRaw,
});
const finish = (claim: Claim) => {
  if ("reused" in claim) throw new Error("expected a miss");
  return claim.finish;
};

describe("cacheKey", () => {
  it("depends on what decides the answer, not on operational knobs or key order", () => {
    expect(cacheKey("tavily", params({ options: { a: 1, b: 2 }, timeoutMs: 500 }))).toBe(
      cacheKey("tavily", params({ options: { b: 2, a: 1 }, maxRetries: 0, includeRaw: true })),
    );
    expect(cacheKey("tavily", params())).not.toBe(cacheKey("exa", params()));
    expect(cacheKey("tavily", params())).not.toBe(cacheKey("tavily", params({ topic: "news" })));
  });
});

describe("ResponseCache", () => {
  it("reuses an answer while it is young enough for the caller and not expired", async () => {
    let now = 0;
    const cache = new ResponseCache(10, () => now);
    const options = { maxAgeMs: 60_000, ttlMs: 60_000, needRaw: false };
    finish(await cache.claim("k", options))(answer("first"));
    now = 30_000;
    expect(await cache.claim("k", options)).toMatchObject({ reused: { callId: "first" } });
    // A caller who accepts only 10 s old answers makes its own call.
    expect("finish" in (await cache.claim("k", { ...options, maxAgeMs: 10_000 }))).toBe(true);
  });

  it("expires answers, drops the least recently used, and never stores failures", async () => {
    let now = 0;
    const cache = new ResponseCache(2, () => now);
    const options = { maxAgeMs: 1000, ttlMs: 1000, needRaw: false };
    for (const key of ["a", "b"]) finish(await cache.claim(key, options))(answer(key));
    await cache.claim("a", options);
    finish(await cache.claim("c", options))(answer("c"));
    expect(cache.size).toBe(2);
    expect(await cache.claim("a", options)).toHaveProperty("reused");
    expect(await cache.claim("b", options)).toHaveProperty("finish");
    finish(await cache.claim("x", options))(null);
    expect(await cache.claim("x", options)).toHaveProperty("finish");
    now = 5000;
    expect(await cache.claim("a", options)).toHaveProperty("finish");
  });

  it("does not hand out an answer without the raw body to a caller who needs it", async () => {
    const cache = new ResponseCache(10);
    finish(await cache.claim("k", { maxAgeMs: 1000, ttlMs: 1000, needRaw: false }))(answer("a"));
    expect(await cache.claim("k", { maxAgeMs: 1000, ttlMs: 1000, needRaw: true })).toHaveProperty(
      "finish",
    );
  });
});
