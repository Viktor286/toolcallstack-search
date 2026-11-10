import {
  CalendarClock,
  CircleDollarSign,
  Coins,
  Hourglass,
  ListOrdered,
  RotateCw,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { PhaseBar } from "@/components/charts/phase-bar";
import { CodeBlock, CopyButton, DownloadButton } from "@/components/json-view";
import { ProviderName } from "@/components/provider-name";
import { ResultList } from "@/components/result-list";
import { StatusLabel } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SearchResponse } from "@/lib/api";
import { callCost, ms, usd } from "@/lib/format";
import type { ResponseSummary } from "@/lib/playground";

/** A labelled figure with an icon; the label is also the tooltip for the icon-only reading. */
export function Metric({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2" title={label}>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-sm font-medium tabular-nums">{children}</dd>
      </div>
    </div>
  );
}

function JsonPane({ value, name }: { value: unknown; name: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <CopyButton text={() => JSON.stringify(value, null, 2)} />
        <DownloadButton name={name} value={value} />
      </div>
      <CodeBlock value={value} />
    </div>
  );
}

interface Props {
  response: SearchResponse;
  /** The provider's display name, used unless the response carries its own label. */
  name?: string;
  summary: ResponseSummary;
  alsoIn?: (url: string) => string[];
}

/** One provider's answer: what it cost and how long it took, then results, JSON or the raw body. */
export function ResponseCard({ response, name, summary, alsoIn }: Props) {
  const cost = callCost(response.usage);
  const { raw, ...unified } = response;
  const file = `${response.label}-${response.id.slice(0, 8)}`;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <ProviderName
            id={response.provider}
            label={response.label === response.provider ? name : response.label}
          />
          <StatusLabel
            kind={response.ok ? "ok" : "failed"}
            label={response.ok ? "OK" : response.error?.type}
          />
        </CardTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 pt-2 sm:grid-cols-4">
          <Metric icon={Timer} label="Total time">
            {ms(response.timing.totalMs)}
          </Metric>
          <Metric icon={CircleDollarSign} label={`Cost (${response.usage.costSource})`}>
            {cost === null ? "unknown" : usd(cost)}
          </Metric>
          <Metric icon={ListOrdered} label="Results">
            {summary.results}
          </Metric>
          <Metric icon={CalendarClock} label="With a date">
            {summary.dated} of {summary.results}
          </Metric>
          {response.usage.credits !== undefined && (
            <Metric icon={Coins} label="Credits">
              {response.usage.credits}
            </Metric>
          )}
          {response.retries.count > 0 && (
            <Metric icon={RotateCw} label="Retries">
              {response.retries.count} ({ms(response.retries.backoffMs)} backoff)
            </Metric>
          )}
          {response.timing.queuedMs >= 1 && (
            <Metric icon={Hourglass} label="Queued">
              {ms(response.timing.queuedMs)}
            </Metric>
          )}
        </dl>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="results">
          <TabsList>
            <TabsTrigger value="results">Results</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
            {raw !== undefined && <TabsTrigger value="raw">Raw upstream</TabsTrigger>}
          </TabsList>
          <TabsContent value="results" className="space-y-4 pt-2">
            {response.error && (
              <p className="rounded-md border px-3 py-2 text-sm break-words text-muted-foreground">
                {response.error.message}
              </p>
            )}
            {response.warnings.length > 0 && (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {response.warnings.map((warning) => (
                  <li key={warning} className="flex gap-2">
                    <TriangleAlert
                      className="mt-0.5 size-4 shrink-0"
                      style={{ color: "var(--status-warning)" }}
                      aria-hidden
                    />
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            {response.timing.phases && (
              <PhaseBar queuedMs={response.timing.queuedMs} phases={response.timing.phases} />
            )}
            {response.ok && <ResultList results={response.results} alsoIn={alsoIn} />}
          </TabsContent>
          <TabsContent value="json" className="pt-2">
            <JsonPane value={unified} name={`${file}.json`} />
          </TabsContent>
          {raw !== undefined && (
            <TabsContent value="raw" className="pt-2">
              <JsonPane value={raw} name={`${file}-upstream.json`} />
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

export function ResponseSkeleton({ id, label }: { id: string; label: string }) {
  return (
    <Card aria-busy>
      <CardHeader>
        <CardTitle className="text-base">
          <ProviderName id={id} label={label} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-3 w-full" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
