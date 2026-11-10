import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BarList } from "@/components/charts/bar-list";
import { StackedTimeBars } from "@/components/charts/stacked-time-bars";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, query, type StatsResponse, type UsageResponse } from "@/lib/api";
import { bucketLabel, compact, ms, percent, usd } from "@/lib/format";
import { byProviderOrder, providerColor } from "@/lib/providers";

const RANGES = [
  { id: "24h", label: "Last 24 hours", hours: 24, bucket: "hour" },
  { id: "7d", label: "Last 7 days", hours: 24 * 7, bucket: "day" },
  { id: "30d", label: "Last 30 days", hours: 24 * 30, bucket: "day" },
] as const;

/** Every bucket start between two times, so empty periods show as gaps and not as missing columns. */
function bucketStarts(from: Date, to: Date, bucket: "hour" | "day"): string[] {
  const step = bucket === "hour" ? 3_600_000 : 86_400_000;
  const starts: string[] = [];
  for (let at = Math.floor(from.getTime() / step) * step; at < to.getTime(); at += step) {
    starts.push(new Date(at).toISOString());
  }
  return starts;
}

function select(id: (typeof RANGES)[number]["id"]) {
  const range = RANGES.find((item) => item.id === id)!;
  const to = new Date();
  return { range, from: new Date(to.getTime() - range.hours * 3_600_000), to };
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <CardContent>
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
        {note && <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

export function UsagePage() {
  // The window is fixed when a range is chosen, so both requests describe the same slice.
  const [selection, setSelection] = useState(() => select("24h"));
  const { range, from, to } = selection;
  const rangeId = range.id;
  const params = { from: from.toISOString(), to: to.toISOString() };

  const stats = useQuery({
    queryKey: ["stats", rangeId],
    queryFn: () => api<StatsResponse>(`/v1/stats${query({ ...params, bucket: range.bucket })}`),
    placeholderData: (previous) => previous,
  });
  const usage = useQuery({
    queryKey: ["usage", rangeId],
    queryFn: () => api<UsageResponse>(`/v1/usage${query(params)}`),
    placeholderData: (previous) => previous,
  });

  const error = stats.error ?? usage.error;
  const points = stats.data?.points ?? [];
  const providers = [...new Set(points.map((point) => point.provider))].toSorted(byProviderOrder);
  const starts = bucketStarts(from, to, range.bucket);
  const index = new Map(starts.map((start, position) => [start, position]));

  const series = providers.map((provider) => {
    const values = starts.map(() => 0);
    for (const point of points) {
      const position = index.get(point.bucket);
      if (point.provider === provider && position !== undefined) values[position] = point.calls;
    }
    return { id: provider, label: provider, color: providerColor(provider), values };
  });

  const totals = providers.map((provider) => {
    const own = points.filter((point) => point.provider === provider);
    const calls = own.reduce((sum, point) => sum + point.calls, 0);
    const ok = own.reduce((sum, point) => sum + point.calls - point.failures, 0);
    // A call-weighted mean of bucket medians: close to the overall median, and honest about being approximate.
    const weighted = own.reduce(
      (sum, point) => sum + (point.p50LatencyMs ?? 0) * (point.calls - point.failures),
      0,
    );
    return {
      provider,
      calls,
      failures: calls - ok,
      latency: ok > 0 ? weighted / ok : null,
      p95: Math.max(...own.map((point) => point.p95LatencyMs ?? 0), 0) || null,
      cost: own.some((point) => point.costUsd !== null)
        ? own.reduce((sum, point) => sum + (point.costUsd ?? 0), 0)
        : null,
    };
  });
  const calls = totals.reduce((sum, row) => sum + row.calls, 0);
  const failures = totals.reduce((sum, row) => sum + row.failures, 0);
  const cost = totals.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const unpriced = totals
    .filter((row) => row.cost === null && row.calls > 0)
    .map((row) => row.provider);

  return (
    <>
      <PageTitle title="Usage" />
      <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Time range">
        {RANGES.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={item.id === rangeId ? "default" : "outline"}
            aria-pressed={item.id === rangeId}
            onClick={() => setSelection(select(item.id))}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {error ? (
        <QueryError error={error} />
      ) : !stats.data ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        // While a new range loads, the previous render stays in place, dimmed.
        <div className={`space-y-4 transition-opacity ${stats.isFetching ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Calls" value={compact(calls)} />
            <Tile
              label="Failed"
              value={percent(failures, calls)}
              note={`${compact(failures)} of ${compact(calls)} calls`}
            />
            <Tile
              label="Cost"
              value={usd(cost)}
              note={
                unpriced.length > 0
                  ? `excludes ${unpriced.join(", ")} (no price set)`
                  : "list price"
              }
            />
            <Tile label="Providers used" value={String(providers.length)} />
          </div>

          {calls === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No calls in this period. Run a search from the Playground to see it here.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Calls per {range.bucket}</CardTitle>
                  <CardDescription>By provider. Times are in your local time zone.</CardDescription>
                </CardHeader>
                <CardContent>
                  <StackedTimeBars
                    label={`Calls per ${range.bucket} by provider`}
                    buckets={starts.map((start) => bucketLabel(start, range.bucket))}
                    series={series}
                    format={compact}
                  />
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Typical latency</CardTitle>
                    <CardDescription>
                      Median of successful calls, with the slowest {range.bucket}'s 95th percentile.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <BarList
                      label="Median latency by provider"
                      rows={totals
                        .filter((row) => row.latency !== null)
                        .toSorted((a, b) => (a.latency ?? 0) - (b.latency ?? 0))
                        .map((row) => ({
                          id: row.provider,
                          label: row.provider,
                          value: row.latency,
                          display: ms(row.latency),
                          note: row.p95 ? `p95 ${ms(row.p95)}` : undefined,
                        }))}
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Cost</CardTitle>
                    <CardDescription>
                      Reported by the provider where it says, otherwise the list-price estimate.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <BarList
                      label="Cost by provider"
                      rows={totals
                        .toSorted((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
                        .map((row) => ({
                          id: row.provider,
                          label: row.provider,
                          value: row.cost,
                          display: row.cost === null ? "no price set" : usd(row.cost),
                          note: `${compact(row.calls)} calls`,
                        }))}
                    />
                  </CardContent>
                </Card>
              </div>
            </>
          )}

          {usage.data && usage.data.providers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cost check per API key</CardTitle>
                <CardDescription>
                  What the gateway counted against what each provider's account says was spent
                  between its first and last balance snapshot in the period.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Requests sent</TableHead>
                      <TableHead className="text-right">Reported</TableHead>
                      <TableHead className="text-right">Estimated</TableHead>
                      <TableHead className="text-right">Account change</TableHead>
                      <TableHead className="text-right">Balance now</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.data.providers
                      .toSorted((a, b) => byProviderOrder(a.provider, b.provider))
                      .map((row) => {
                        const unit = row.balance?.unit;
                        const amount = (value: number | null | undefined) =>
                          value == null
                            ? "–"
                            : unit === "usd"
                              ? usd(value)
                              : `${compact(value)} credits`;
                        return (
                          <TableRow key={`${row.provider}-${row.keyFingerprint}`}>
                            <TableCell>
                              <ProviderName id={row.provider} />
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {row.keyFingerprint}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {compact(row.calls)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {compact(row.upstreamRequests)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.reportedCostUsd !== null
                                ? usd(row.reportedCostUsd)
                                : row.credits !== null
                                  ? `${compact(row.credits)} credits`
                                  : "–"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {usd(row.estimatedCostUsd)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {amount(row.balance?.window?.spent)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.balance?.latest.remaining != null
                                ? `${amount(row.balance.latest.remaining)} left`
                                : row.balance?.latest.used != null
                                  ? `${amount(row.balance.latest.used)} used`
                                  : "not reported"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
