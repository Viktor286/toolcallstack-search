import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, Clock, RefreshCw, Search, SearchX, Tag, User, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { CallDetail } from "@/components/call-detail";
import { MetricHelp } from "@/components/metric-help";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, query, type CallsPage as Page, type ProviderInfo } from "@/lib/api";
import {
  RANGES,
  callsQuery,
  errorTypes,
  filtersFromParams,
  filtersToParams,
  type CallFilters,
} from "@/lib/call-filters";
import { callCost, dateTime, ms, usd } from "@/lib/format";

const AUTO_REFRESH_MS = 10_000;

/** A text filter that updates the address bar once typing pauses, not on every key. */
function TextFilter({
  value,
  onChange,
  label,
  icon: Icon,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  icon: typeof Search;
  className: string;
}) {
  const [draft, setDraft] = useState(value);
  // A filter changed elsewhere (a link, the back button) replaces what was typed.
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);
  return (
    <div className="relative">
      <Icon
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        className={`${className} pl-9`}
        placeholder={label}
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </div>
  );
}

function windowText(from: string, to: string): string {
  if (from && to) return `${dateTime(from)} – ${dateTime(to)}`;
  return from ? `from ${dateTime(from)}` : `until ${dateTime(to)}`;
}

export function CallsPage() {
  // Filters live in the address bar; /calls/:id opens one call over the list.
  const [params, setParams] = useSearchParams();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const filters = filtersFromParams(params);
  const [live, setLive] = useState(false);

  const update = (change: Partial<CallFilters>) =>
    setParams(filtersToParams({ ...filters, ...change }), { replace: true });
  const open = (callId: string) =>
    navigate({ pathname: `/calls/${callId}`, search: location.search });
  const close = () => navigate({ pathname: "/calls", search: location.search });

  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderInfo[] }>("/v1/providers"),
  });
  const calls = useInfiniteQuery({
    queryKey: ["calls", filtersToParams(filters).toString()],
    // A recent range is anchored at the moment of each fetch, so a refresh moves it along.
    queryFn: ({ pageParam }) =>
      api<Page>(`/v1/calls${query({ limit: 50, ...callsQuery(filters), cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
    refetchInterval: live ? AUTO_REFRESH_MS : false,
  });
  const rows = calls.data?.pages.flatMap((page) => page.calls) ?? [];
  const exact = filters.from || filters.to;
  const refreshing = calls.isFetching && !calls.isFetchingNextPage;
  const filtered = filtersToParams(filters).size > 0;

  return (
    <>
      <PageTitle title="Calls">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="auto-refresh"
              checked={live}
              onCheckedChange={(checked) => setLive(checked === true)}
            />
            <Label htmlFor="auto-refresh" className="text-sm font-normal text-muted-foreground">
              Auto-refresh
            </Label>
          </div>
          <Button variant="outline" size="sm" onClick={() => void calls.refetch()}>
            <RefreshCw className={refreshing && !live ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={filters.provider || "all"}
          onValueChange={(value) => update({ provider: value === "all" ? "" : value })}
        >
          <SelectTrigger className="w-40" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {providers.data?.providers.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.errorType || filters.ok || "all"}
          onValueChange={(value) =>
            update(
              value === "true" || value === "false"
                ? { ok: value, errorType: "" }
                : value === "all"
                  ? { ok: "", errorType: "" }
                  : { ok: "", errorType: value as CallFilters["errorType"] },
            )
          }
        >
          <SelectTrigger className="w-44" aria-label="Outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any outcome</SelectItem>
            <SelectItem value="true">Succeeded</SelectItem>
            <SelectItem value="false">Failed</SelectItem>
            {errorTypes.map((type) => (
              <SelectItem key={type} value={type}>
                Failed: {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!exact && (
          <Select
            value={filters.range}
            onValueChange={(value) => update({ range: value as CallFilters["range"] })}
          >
            <SelectTrigger className="w-40" aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((range) => (
                <SelectItem key={range.id} value={range.id}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <TextFilter
          value={filters.q}
          onChange={(q) => update({ q })}
          label="Query contains"
          icon={Search}
          className="w-52"
        />
        <TextFilter
          value={filters.label}
          onChange={(label) => update({ label })}
          label="Label"
          icon={Tag}
          className="w-36"
        />
        <TextFilter
          value={filters.client}
          onChange={(client) => update({ client })}
          label="Client name"
          icon={User}
          className="w-40"
        />
        {exact && (
          <Button
            variant="secondary"
            size="sm"
            aria-label="Remove the time window"
            onClick={() => update({ from: "", to: "" })}
          >
            <Clock />
            {windowText(filters.from, filters.to)}
            <X />
          </Button>
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </Button>
        )}
      </div>

      {calls.error ? (
        <QueryError error={calls.error} />
      ) : (
        <div className={`transition-opacity ${refreshing && !live ? "opacity-60" : ""}`}>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <MetricHelp metric="sent">Sent</MetricHelp>
                  </TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Query</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">
                    <MetricHelp metric="results">Results</MetricHelp>
                  </TableHead>
                  <TableHead className="text-right">
                    <MetricHelp metric="totalTime">Total</MetricHelp>
                  </TableHead>
                  <TableHead className="text-right">
                    <MetricHelp metric="queued">Queued</MetricHelp>
                  </TableHead>
                  <TableHead className="text-right">
                    <MetricHelp metric="retries">Retries</MetricHelp>
                  </TableHead>
                  <TableHead className="text-right">
                    <MetricHelp metric="cost">Cost</MetricHelp>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((call) => (
                  <TableRow
                    key={call.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    data-state={call.id === id ? "selected" : undefined}
                    onClick={() => open(call.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        open(call.id);
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {dateTime(call.timing.sentAt)}
                    </TableCell>
                    <TableCell>
                      <ProviderName id={call.provider} label={call.label} />
                    </TableCell>
                    <TableCell className="max-w-64 truncate">{call.query}</TableCell>
                    <TableCell>
                      <StatusLabel
                        kind={call.ok ? "ok" : "failed"}
                        label={
                          call.ok ? (call.cache?.hit ? "OK · cached" : "OK") : call.error?.type
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{call.results.length}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {ms(call.timing.totalMs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {call.timing.queuedMs >= 1 ? ms(call.timing.queuedMs) : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {call.retries.count || "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(callCost(call.usage))}
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && !calls.isLoading && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                      <SearchX className="mx-auto mb-2 size-6" aria-hidden />
                      No calls match. Clear the filters, or run a search from the Playground.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {calls.hasNextPage && (
            <div className="mt-4 text-center">
              <Button
                variant="outline"
                disabled={calls.isFetchingNextPage}
                onClick={() => void calls.fetchNextPage()}
              >
                <ChevronDown />
                {calls.isFetchingNextPage ? "Loading…" : "Load older calls"}
              </Button>
            </div>
          )}
        </div>
      )}

      <Sheet open={id !== undefined} onOpenChange={(next) => !next && close()}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Call</SheetTitle>
            <SheetDescription>
              Timing, attempts, cost and results of one search call.
            </SheetDescription>
          </SheetHeader>
          {id && <CallDetail id={id} initial={rows.find((call) => call.id === id)} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
