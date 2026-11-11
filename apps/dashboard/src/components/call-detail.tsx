import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Coins,
  CircleDollarSign,
  FileJson,
  Gauge,
  Hourglass,
  ListOrdered,
  RotateCw,
  Server,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { PhaseBar } from "@/components/charts/phase-bar";
import { CodeBlock } from "@/components/json-view";
import { MetricHelp } from "@/components/metric-help";
import { ProviderName } from "@/components/provider-name";
import { ResultList } from "@/components/result-list";
import { StatusLabel } from "@/components/status";
import { Separator } from "@/components/ui/separator";
import { api, type SearchResponse } from "@/lib/api";
import type { MetricId } from "@/lib/metric-docs";
import { callCost, dateTime, ms, usd } from "@/lib/format";

function Fact({
  label,
  icon: Icon,
  help,
  children,
}: {
  label: string;
  icon: LucideIcon;
  help: MetricId;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">
          <MetricHelp metric={help}>{label}</MetricHelp>
        </dt>
        <dd className="text-sm font-medium tabular-nums">{children}</dd>
      </div>
    </div>
  );
}

function Heading({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {children}
    </h3>
  );
}

/** Everything the gateway recorded about one call. */
export function CallDetail({ call }: { call: SearchResponse }) {
  // The list omits raw upstream bodies; fetch the single call to get one if it was stored.
  const full = useQuery({
    queryKey: ["call", call.id],
    queryFn: () => api<SearchResponse>(`/v1/calls/${call.id}`),
  });
  const raw = full.data?.raw;
  const cost = callCost(call.usage);

  return (
    <div className="space-y-5 px-4 pb-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <ProviderName id={call.provider} label={call.label} />
        <StatusLabel kind={call.ok ? "ok" : "failed"} label={call.ok ? "OK" : call.error?.type} />
        <span className="text-sm text-muted-foreground">{dateTime(call.timing.sentAt)}</span>
      </div>
      <p className="text-sm break-words">“{call.query}”</p>
      {call.error && (
        <p className="rounded-md border px-3 py-2 text-sm break-words text-muted-foreground">
          {call.error.message}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Total" icon={Timer} help="totalTime">
          {ms(call.timing.totalMs)}
        </Fact>
        <Fact label="Final attempt" icon={Gauge} help="finalAttempt">
          {ms(call.timing.latencyMs)}
        </Fact>
        <Fact label="Retries" icon={RotateCw} help="retries">
          {call.retries.count}
        </Fact>
        <Fact label="Upstream status" icon={Server} help="upstreamStatus">
          {call.upstream.status ?? "–"}
        </Fact>
        <Fact label="Results" icon={ListOrdered} help="results">
          {call.results.length}
        </Fact>
        <Fact label="Cost" icon={CircleDollarSign} help="cost">
          {cost === null ? "unknown" : `${usd(cost)} (${call.usage.costSource})`}
        </Fact>
        <Fact label="Credits" icon={Coins} help="credits">
          {call.usage.credits ?? "–"}
        </Fact>
        <Fact label="Backoff" icon={Hourglass} help="backoff">
          {ms(call.retries.backoffMs)}
        </Fact>
      </dl>

      <section>
        <Heading icon={Timer}>Where the time went (final attempt)</Heading>
        <PhaseBar queuedMs={call.timing.queuedMs} phases={call.timing.phases} />
      </section>

      {call.retries.attempts.length > 1 && (
        <section>
          <Heading icon={RotateCw}>Attempts</Heading>
          <ol className="space-y-1 text-sm">
            {call.retries.attempts.map((attempt, index) => (
              <li key={attempt.sentAt + index} className="flex flex-wrap gap-x-4 tabular-nums">
                <span className="text-muted-foreground">{index + 1}.</span>
                <span>{attempt.error ?? "ok"}</span>
                <span className="text-muted-foreground">
                  status {attempt.upstreamStatus ?? "–"}
                </span>
                <span className="text-muted-foreground">{ms(attempt.latencyMs)}</span>
                {attempt.backoffMs !== null && (
                  <span className="text-muted-foreground">then waited {ms(attempt.backoffMs)}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {call.fallback.tried.length > 0 && (
        <section>
          <Heading icon={ArrowRightLeft}>Fell back after</Heading>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {call.fallback.tried.map((tried) => (
              <li key={tried.callId}>
                {tried.provider}: {tried.error.type}
              </li>
            ))}
          </ul>
        </section>
      )}

      {call.warnings.length > 0 && (
        <section>
          <Heading icon={TriangleAlert}>Warnings</Heading>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {call.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <Separator />
      <section>
        <Heading icon={ListOrdered}>Results</Heading>
        <ResultList results={call.results} />
      </section>

      {raw !== undefined && (
        <section>
          <Heading icon={FileJson}>Raw upstream response</Heading>
          <CodeBlock value={raw} className="max-h-96" />
        </section>
      )}
      <p className="font-mono text-xs text-muted-foreground">{call.id}</p>
    </div>
  );
}
