import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleDollarSign,
  Clock,
  Database,
  FlaskConical,
  HeartPulse,
  RefreshCw,
  Tag,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ProviderCard } from "@/components/overview/provider-card";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
import { StatusLabel } from "@/components/status";
import { Tile } from "@/components/tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  api,
  query,
  type ProviderInfo,
  type StatsResponse,
  type Status,
  type UsageResponse,
} from "@/lib/api";
import { ago, compact, duration, percent, usd } from "@/lib/format";
import {
  activityByProvider,
  balanceText,
  byAttention,
  healthCounts,
  isActive,
  seriesStart,
  type Balance,
} from "@/lib/overview";

/** The current time, refreshed so "updated 12s ago" and the forecasts keep moving. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function OverviewPage() {
  const now = useNow(5_000);
  // Only a refresh the user asked for shows as one; background polls stay quiet.
  const [refreshing, setRefreshing] = useState(false);
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => api<Status>("/v1/status"),
    refetchInterval: 10_000,
  });
  const store = status.data?.store;
  // Budgets and names are extras: the page renders from the status alone.
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderInfo[] }>("/v1/providers"),
    refetchInterval: 10_000,
  });
  // Balances and history come from the call log's database; the page works without it.
  const usage = useQuery({
    queryKey: ["usage", "latest"],
    queryFn: () => api<UsageResponse>("/v1/usage"),
    refetchInterval: 60_000,
    enabled: store === "ok",
  });
  const stats = useQuery({
    queryKey: ["stats", "overview"],
    queryFn: () => {
      const to = new Date();
      const from = seriesStart(to.getTime());
      return api<StatsResponse>(
        `/v1/stats${query({ from: from.toISOString(), to: to.toISOString(), bucket: "hour" })}`,
      );
    },
    refetchInterval: 60_000,
    enabled: store === "ok",
  });

  // A rejected key needs the key prompt, even over data loaded with the old key.
  const keyRejected = status.error instanceof ApiError && status.error.status === 401;
  if (status.error && (!status.data || keyRejected)) return <QueryError error={status.error} />;
  if (!status.data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-72" />
          ))}
        </div>
      </div>
    );
  }

  const gateway = status.data;
  const info = new Map(
    (providers.data?.providers ?? []).map((provider) => [provider.id, provider]),
  );
  // A rotated key leaves older rows behind; the freshest snapshot is the one that counts.
  const balances = new Map<string, Balance>();
  for (const row of usage.data?.providers ?? []) {
    const known = balances.get(row.provider);
    if (row.balance && (!known || row.balance.latest.takenAt > known.latest.takenAt)) {
      balances.set(row.provider, row.balance);
    }
  }
  const activity = stats.data ? activityByProvider(stats.data.points, now) : undefined;
  // Which providers get a card depends on their history; wait for it rather than reshuffle.
  const historyPending = store === "ok" && stats.isPending;
  const rows = byAttention(gateway.providers, (id) => activity?.get(id)?.calls ?? 0);
  const active = rows.filter((row) => isActive(row.rank));
  const idle = rows.filter((row) => !isActive(row.rank));
  const counts = healthCounts(gateway.providers);
  const demo = gateway.providers.some(
    (provider) => provider.configured && provider.id.startsWith("demo-"),
  );

  const calls = [...(activity?.values() ?? [])].reduce((sum, item) => sum + item.calls, 0);
  const failures = [...(activity?.values() ?? [])].reduce((sum, item) => sum + item.failures, 0);
  const cost = [...(activity?.values() ?? [])].reduce((sum, item) => sum + (item.cost ?? 0), 0);
  const unpriced = [...(activity?.entries() ?? [])]
    .filter(([, item]) => item.cost === null && item.calls > 0)
    .map(([id]) => id);

  const refresh = () => {
    setRefreshing(true);
    void Promise.allSettled([
      status.refetch(),
      providers.refetch(),
      ...(store === "ok" ? [usage.refetch(), stats.refetch()] : []),
    ]).finally(() => setRefreshing(false));
  };
  const withData = counts.configured - counts.idle;
  const updatedAt = new Date(status.dataUpdatedAt).toISOString();

  return (
    <>
      <PageTitle title="Overview">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
          {demo && (
            <Badge variant="secondary">
              <FlaskConical />
              Demo mode
            </Badge>
          )}
          <StatusLabel
            kind={gateway.status === "ok" ? "ok" : "degraded"}
            label={gateway.status === "ok" ? "Gateway OK" : "Gateway degraded"}
          />
          <span className="inline-flex items-center gap-1.5">
            <Tag className="size-3.5" aria-hidden />v{gateway.version}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3.5" aria-hidden />
            up {duration(gateway.uptimeSeconds)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Database className="size-3.5" aria-hidden />
            call log{" "}
            {gateway.store === "ok" ? "on" : gateway.store === "none" ? "off" : "unreachable"}
          </span>
          <span className="flex items-center gap-2">
            <span>updated {ago(updatedAt, now)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              aria-busy={refreshing}
              onClick={refresh}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              Refresh
            </Button>
          </span>
        </div>
      </PageTitle>

      {status.isError && (
        <p className="mb-4 text-sm text-muted-foreground" role="status">
          <StatusLabel kind="degraded" label="Could not refresh." /> Showing what the gateway
          reported {ago(updatedAt, now)}.
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          icon={HeartPulse}
          label="Providers"
          help="providersTile"
          value={withData > 0 ? `${counts.healthy} of ${withData} healthy` : "No calls yet"}
          note={
            [
              counts.degraded > 0 && `${counts.degraded} degraded`,
              counts.down > 0 && `${counts.down} down`,
              counts.blocked > 0 && `${counts.blocked} over budget`,
              counts.idle > 0 && `${counts.idle} without calls since start`,
            ]
              .filter(Boolean)
              .join(" · ") || "no problems"
          }
        />
        {activity && (
          <>
            <Tile icon={Activity} label="Calls, 24 h" help="calls24h" value={compact(calls)} />
            <Tile
              icon={TriangleAlert}
              label="Failed, 24 h"
              help="failedShare"
              value={percent(failures, calls)}
              note={`${compact(failures)} of ${compact(calls)} calls`}
            />
            <Tile
              icon={CircleDollarSign}
              label="Cost, 24 h"
              help="cost24h"
              value={usd(cost)}
              note={
                unpriced.length > 0
                  ? `excludes ${unpriced.join(", ")} (no price set)`
                  : "reported, else list price"
              }
            />
          </>
        )}
      </div>

      {historyPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-72" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {active.map(({ provider }) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                info={info.get(provider.id)}
                balance={balances.get(provider.id)}
                activity={activity?.get(provider.id)}
                store={gateway.store}
                now={now}
              />
            ))}
          </div>

          {idle.length > 0 && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-base">
                  {active.length > 0 ? "Not in use" : "Providers"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {idle.map(({ provider }) => {
                    const details = info.get(provider.id);
                    const balance = balanceText(balances.get(provider.id), details, gateway.store);
                    return (
                      <li
                        key={provider.id}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm first:pt-0 last:pb-0"
                      >
                        <span className="font-medium">
                          <ProviderName id={provider.id} label={details?.name ?? provider.id} />
                        </span>
                        <span className="flex flex-wrap items-center gap-x-4 text-muted-foreground">
                          {provider.configured ? (
                            <>
                              {balance.known && (
                                <span className="tabular-nums">{balance.text}</span>
                              )}
                              <StatusLabel kind="unknown" label="No calls yet" />
                            </>
                          ) : (
                            <>
                              {details?.envVar && (
                                <span>
                                  set <code className="text-foreground">{details.envVar}</code>
                                </span>
                              )}
                              <StatusLabel kind="off" />
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}
