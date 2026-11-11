import { MetricHelp } from "@/components/metric-help";
import { ProviderName } from "@/components/provider-name";
import { StatusLabel } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SearchResponse } from "@/lib/api";
import { ago, callCost, ms, usd } from "@/lib/format";
import type { ResponseSummary } from "@/lib/playground";

interface Props {
  responses: SearchResponse[];
  summaries: ResponseSummary[];
  names: Record<string, string>;
}

function lowest(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  // A winner among one is not a comparison.
  return known.length > 1 ? Math.min(...known) : null;
}

/** The same query across providers, one row each, so speed, coverage and cost can be compared. */
export function Comparison({ responses, summaries, names }: Props) {
  const times = responses.map((response) => (response.ok ? response.timing.totalMs : null));
  const costs = responses.map((response) => (response.ok ? callCost(response.usage) : null));
  const fastest = lowest(times);
  const cheapest = lowest(costs);
  const slowest = Math.max(...responses.map((response) => response.timing.totalMs), 1);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="min-w-40">
            <MetricHelp metric="totalTime">Total time</MetricHelp>
          </TableHead>
          <TableHead className="text-right">
            <MetricHelp metric="cost">Cost</MetricHelp>
          </TableHead>
          <TableHead className="text-right">
            <MetricHelp metric="results">Results</MetricHelp>
          </TableHead>
          <TableHead className="text-right">
            <MetricHelp metric="dated">Dated</MetricHelp>
          </TableHead>
          <TableHead className="text-right">
            <MetricHelp metric="unique">Unique</MetricHelp>
          </TableHead>
          <TableHead>
            <MetricHelp metric="newest">Newest</MetricHelp>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {responses.map((response, index) => {
          const summary = summaries[index]!;
          const cost = callCost(response.usage);
          return (
            <TableRow key={response.id}>
              <TableCell className="font-medium">
                <ProviderName
                  id={response.provider}
                  label={
                    response.label === response.provider ? names[response.provider] : response.label
                  }
                />
              </TableCell>
              <TableCell>
                <StatusLabel
                  kind={response.ok ? "ok" : "failed"}
                  label={response.ok ? "OK" : response.error?.type}
                />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2 tabular-nums">
                  <span className="w-16 shrink-0">{ms(response.timing.totalMs)}</span>
                  <span className="h-2 flex-1" aria-hidden>
                    <span
                      className="block h-full rounded-r-[4px]"
                      style={{
                        width: `${Math.max(2, (response.timing.totalMs / slowest) * 100)}%`,
                        background: "var(--magnitude)",
                      }}
                    />
                  </span>
                  {times[index] !== null && times[index] === fastest && (
                    <Badge variant="secondary">fastest</Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span className="inline-flex items-center gap-2">
                  {costs[index] !== null && costs[index] === cheapest && (
                    <Badge variant="secondary">cheapest</Badge>
                  )}
                  {cost === null ? "unknown" : usd(cost)}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{summary.results}</TableCell>
              <TableCell className="text-right tabular-nums">{summary.dated}</TableCell>
              <TableCell className="text-right tabular-nums">{summary.unique}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {summary.newestAt ? ago(summary.newestAt) : "–"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
