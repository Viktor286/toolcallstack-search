/**
 * End-to-end smoke test: one real query through a running gateway to every
 * provider it has a key for. Exits non-zero if any provider fails or returns
 * nothing. Usage: pnpm smoke ["query"]
 */
import type { BatchResponse } from "../src/schema.ts";

const base = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 4310}`;
const token = process.env.GATEWAY_API_KEY ?? process.env.GATEWAY_API_KEYS?.split(",")[0]?.trim();
const query = process.argv[2] ?? "Federal Reserve interest rate decision";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`${path} responded ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const { providers } = await call<{ providers: { id: string; configured: boolean }[] }>(
  "/v1/providers",
);
const configured = providers.filter((provider) => provider.configured).map((p) => p.id);
if (configured.length === 0) {
  console.error("no providers are configured on the gateway");
  process.exit(1);
}

const batch = await call<BatchResponse>("/v1/search/batch", {
  providers: configured,
  query,
  maxResults: 5,
});
const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : String(Math.round(value));
let failures = 0;
console.log(`query: ${JSON.stringify(query)}  dispatched: ${batch.dispatchedAt}\n`);
console.log("      provider      total   conn   ttfb  body  retries  results  dated  cost (USD)");
for (const response of batch.responses) {
  const passed = response.ok && response.results.length > 0;
  if (!passed) failures += 1;
  const phases = response.timing.phases;
  const connect = phases?.connectionReused
    ? "reuse"
    : ms(phases && (phases.dnsMs ?? 0) + (phases.connectMs ?? 0) + (phases.tlsMs ?? 0));
  const cost = response.usage.costUsd ?? response.usage.estimatedCostUsd;
  console.log(
    [
      passed ? "PASS " : "FAIL ",
      response.label.padEnd(12),
      ms(response.timing.totalMs).padStart(6),
      connect.padStart(6),
      ms(phases?.ttfbMs).padStart(6),
      ms(phases?.downloadMs).padStart(5),
      String(response.retries.count).padStart(8),
      String(response.results.length).padStart(8),
      String(response.results.filter((result) => result.publishedAt !== null).length).padStart(6),
      ` ${cost === undefined ? "unknown" : cost.toFixed(4)} ${response.usage.costSource === "unknown" ? "" : `(${response.usage.costSource})`}`,
    ].join(" "),
  );
  if (!response.ok) console.log(`      ${response.error?.type}: ${response.error?.message}`);
}
console.log(`\n${batch.responses.length - failures}/${batch.responses.length} providers passed`);
process.exit(failures > 0 ? 1 : 0);
