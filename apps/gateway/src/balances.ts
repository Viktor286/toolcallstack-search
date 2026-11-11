import type { FastifyBaseLogger } from "fastify";
import type { BudgetTracker } from "./budget.ts";
import type { Metrics } from "./metrics.ts";
import { providers } from "./providers/index.ts";
import type { Provider } from "./providers/types.ts";
import type { Store } from "./store.ts";
import type { Transport } from "./transport.ts";
import { keyFingerprint } from "./util.ts";

export interface BalancePollerDeps {
  transport: Transport;
  env: Record<string, string | undefined>;
  /** Where snapshots are kept; without one, balances only feed metrics and budgets. */
  store: Store | null;
  metrics: Metrics;
  /** Told about each fresh balance, for `minRemaining` budgets. */
  budget?: BudgetTracker;
  log: FastifyBaseLogger;
}

/** The credential that can read a provider's account, or undefined when it is not set. */
export function balanceCredential(
  provider: Provider,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!provider.balance) return undefined;
  return env[provider.balance.credentialEnvVar ?? provider.envVar] || undefined;
}

/**
 * Snapshot the account balance of every configured provider that exposes one.
 * Comparing snapshots over time gives the real spend per API key, which per-call
 * figures can only estimate.
 */
export async function pollBalances(deps: BalancePollerDeps): Promise<number> {
  const saved = await Promise.all(
    providers.map(async (provider) => {
      const apiKey = deps.env[provider.envVar];
      const credential = balanceCredential(provider, deps.env);
      if (!provider.balance || !apiKey || !credential) return false;
      try {
        const response = await deps.transport({
          method: "GET",
          ...provider.balance.request({ apiKey, credential, now: new Date() }),
          timeoutMs: 20_000,
        });
        const balance =
          response.status === 200 ? provider.balance.parse(JSON.parse(response.text)) : null;
        if (!balance) throw new Error(`unexpected balance response (${response.status})`);
        await deps.store?.saveBalance({
          ...balance,
          provider: provider.id,
          keyFingerprint: keyFingerprint(apiKey),
          takenAt: new Date(),
        });
        deps.budget?.setBalance(provider.id, balance.remaining);
        if (balance.remaining === null && deps.budget?.hasFloor(provider.id)) {
          deps.log.warn(
            { provider: provider.id },
            "minRemaining cannot apply: this provider reports what was used, not what is left",
          );
        }
        if (balance.remaining !== null) {
          deps.metrics.balance.set(
            { provider: provider.id, unit: balance.unit },
            balance.remaining,
          );
        }
        return true;
      } catch (error) {
        deps.metrics.storeFailures.inc();
        deps.log.warn({ err: error, provider: provider.id }, "could not snapshot balance");
        return false;
      }
    }),
  );
  return saved.filter(Boolean).length;
}

/** Poll now and then every `intervalSeconds`; returns a function that stops it. */
export function startBalancePoller(deps: BalancePollerDeps, intervalSeconds: number): () => void {
  void pollBalances(deps);
  const timer = setInterval(() => void pollBalances(deps), intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
