import { useQuery } from "@tanstack/react-query";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
import { StatusLabel, type StatusKind } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ProviderInfo, type Status, type UsageResponse } from "@/lib/api";
import { ago, compact, duration, ms, usd } from "@/lib/format";

type Budget = NonNullable<ProviderInfo["budget"]>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Spend against a cap; the track is a lighter step of the fill's own hue. */
function BudgetMeter({ title, period }: { title: string; period: NonNullable<Budget["daily"]> }) {
  const units = (["calls", "usd", "credits"] as const).filter(
    (unit) => period.caps[unit] !== undefined,
  );
  return (
    <>
      {units.map((unit) => {
        const cap = period.caps[unit] ?? 0;
        const spent = period.spent[unit];
        const show = (value: number) => (unit === "usd" ? usd(value) : compact(value));
        return (
          <div key={unit} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{title}</span>
              <span className="font-medium tabular-nums">
                {show(spent)} of {show(cap)}
                {unit === "usd" ? "" : ` ${unit}`}
              </span>
            </div>
            <div
              className="mt-1 h-1.5 rounded-full"
              style={{ background: "var(--magnitude-track)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${cap > 0 ? Math.min(100, (spent / cap) * 100) : 100}%`,
                  background: spent >= cap ? "var(--status-critical)" : "var(--magnitude)",
                }}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

export function OverviewPage() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => api<Status>("/v1/status"),
    refetchInterval: 10_000,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderInfo[] }>("/v1/providers"),
    refetchInterval: 10_000,
  });
  // Balances come from the call log's database; the page works without it.
  const usage = useQuery({
    queryKey: ["usage", "latest"],
    queryFn: () => api<UsageResponse>("/v1/usage"),
    refetchInterval: 60_000,
  });

  const error = status.error ?? providers.error;
  if (error) return <QueryError error={error} />;
  if (!status.data || !providers.data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-52" />
        ))}
      </div>
    );
  }

  const info = new Map(providers.data.providers.map((provider) => [provider.id, provider]));
  const balances = new Map(
    (usage.data?.providers ?? [])
      .filter((row) => row.balance)
      .map((row) => [row.provider, row.balance!]),
  );

  return (
    <>
      <PageTitle title="Overview">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <StatusLabel
            kind={status.data.status === "ok" ? "ok" : "degraded"}
            label={status.data.status === "ok" ? "Gateway OK" : "Gateway degraded"}
          />
          <span>v{status.data.version}</span>
          <span>up {duration(status.data.uptimeSeconds)}</span>
          <span>
            call log{" "}
            {status.data.store === "ok"
              ? "on"
              : status.data.store === "none"
                ? "off"
                : "unreachable"}
          </span>
        </div>
      </PageTitle>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {status.data.providers.map((provider) => {
          const details = info.get(provider.id);
          const balance = balances.get(provider.id);
          const kind: StatusKind = provider.configured ? provider.status : "off";
          return (
            <Card key={provider.id} className={provider.configured ? "" : "opacity-60"}>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-base">
                  <ProviderName id={provider.id} label={details?.name ?? provider.id} />
                </CardTitle>
                <StatusLabel kind={kind} />
              </CardHeader>
              <CardContent>
                {provider.configured ? (
                  <dl className="space-y-1.5">
                    <Row label="Median latency">{ms(provider.medianLatencyMs)}</Row>
                    <Row label="Success">
                      {provider.successRate === null
                        ? "–"
                        : `${Math.round(provider.successRate * 100)}% of last ${provider.recentCalls}`}
                    </Row>
                    <Row label="Last success">{ago(provider.lastOkAt)}</Row>
                    {provider.queueDepth > 0 && <Row label="Queued now">{provider.queueDepth}</Row>}
                    <Row label="Balance">
                      {balance?.latest.remaining != null
                        ? balance.unit === "usd"
                          ? `${usd(balance.latest.remaining)} left`
                          : `${compact(balance.latest.remaining)} credits left`
                        : balance?.latest.used != null
                          ? `${balance.unit === "usd" ? usd(balance.latest.used) : compact(balance.latest.used)} used`
                          : "not reported"}
                    </Row>
                    {details?.budget?.daily && (
                      <BudgetMeter title="Today" period={details.budget.daily} />
                    )}
                    {details?.budget?.monthly && (
                      <BudgetMeter title="This month" period={details.budget.monthly} />
                    )}
                    {provider.budgetBlocked && (
                      <p className="pt-1 text-xs text-muted-foreground">{provider.budgetBlocked}</p>
                    )}
                    {provider.lastError && provider.status !== "healthy" && (
                      <p className="pt-1 text-xs break-words text-muted-foreground">
                        Last error ({ago(provider.lastError.at)}): {provider.lastError.type}.{" "}
                        {provider.lastError.message.slice(0, 140)}
                      </p>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Set <code className="text-foreground">{details?.envVar}</code> on the gateway to
                    use this provider.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
