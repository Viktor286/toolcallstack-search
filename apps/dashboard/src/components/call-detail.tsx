import { useQuery } from "@tanstack/react-query";
import { PhaseBar } from "@/components/charts/phase-bar";
import { ProviderName } from "@/components/provider-name";
import { StatusLabel } from "@/components/status";
import { Separator } from "@/components/ui/separator";
import { api, type SearchResponse } from "@/lib/api";
import { callCost, dateTime, ms, usd } from "@/lib/format";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function ResultList({ results }: { results: SearchResponse["results"] }) {
  if (results.length === 0) return <p className="text-sm text-muted-foreground">No results.</p>;
  return (
    <ol className="space-y-3">
      {results.map((result) => (
        <li key={`${result.position}-${result.url}`} className="text-sm">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline-offset-4 hover:underline"
          >
            {result.position}. {result.title || "(untitled)"}
          </a>
          <div className="truncate text-xs text-muted-foreground">{result.url}</div>
          <div className="text-xs text-muted-foreground">
            {result.publishedAt
              ? `Published ${dateTime(result.publishedAt)}${result.publishedPrecision === "datetime" ? "" : ` (${result.publishedPrecision} precision)`}`
              : "No publish date"}
          </div>
          {result.snippet && (
            <p className="mt-1 line-clamp-3 text-muted-foreground">{result.snippet}</p>
          )}
        </li>
      ))}
    </ol>
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
        <Fact label="Total">{ms(call.timing.totalMs)}</Fact>
        <Fact label="Final attempt">{ms(call.timing.latencyMs)}</Fact>
        <Fact label="Retries">{call.retries.count}</Fact>
        <Fact label="Upstream status">{call.upstream.status ?? "–"}</Fact>
        <Fact label="Results">{call.results.length}</Fact>
        <Fact label="Cost">
          {cost === null ? "unknown" : `${usd(cost)} (${call.usage.costSource})`}
        </Fact>
        <Fact label="Credits">{call.usage.credits ?? "–"}</Fact>
        <Fact label="Backoff">{ms(call.retries.backoffMs)}</Fact>
      </dl>

      <section>
        <h3 className="mb-2 text-sm font-medium">Where the time went (final attempt)</h3>
        <PhaseBar queuedMs={call.timing.queuedMs} phases={call.timing.phases} />
      </section>

      {call.retries.attempts.length > 1 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Attempts</h3>
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
          <h3 className="mb-2 text-sm font-medium">Fell back after</h3>
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
          <h3 className="mb-2 text-sm font-medium">Warnings</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {call.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <Separator />
      <section>
        <h3 className="mb-3 text-sm font-medium">Results</h3>
        <ResultList results={call.results} />
      </section>

      {raw !== undefined && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Raw upstream response</h3>
          <pre className="max-h-96 overflow-auto rounded-md border p-3 text-xs">
            {JSON.stringify(raw, null, 2)}
          </pre>
        </section>
      )}
      <p className="font-mono text-xs text-muted-foreground">{call.id}</p>
    </div>
  );
}
