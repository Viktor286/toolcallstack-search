import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, RefreshCw, SearchX, User } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { CallDetail } from "@/components/call-detail";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  api,
  query,
  type CallsPage as Page,
  type ProviderInfo,
  type SearchResponse,
} from "@/lib/api";
import { callCost, dateTime, ms, usd } from "@/lib/format";

export function CallsPage() {
  // Overview links here with ?provider=…&ok=false.
  const [params] = useSearchParams();
  const [provider, setProvider] = useState(params.get("provider") ?? "all");
  const [outcome, setOutcome] = useState(
    ["true", "false"].includes(params.get("ok") ?? "") ? params.get("ok")! : "all",
  );
  const [client, setClient] = useState("");
  const [open, setOpen] = useState<SearchResponse | null>(null);

  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderInfo[] }>("/v1/providers"),
  });
  const calls = useInfiniteQuery({
    queryKey: ["calls", provider, outcome, client],
    queryFn: ({ pageParam }) =>
      api<Page>(
        `/v1/calls${query({
          limit: 50,
          provider: provider === "all" ? undefined : provider,
          ok: outcome === "all" ? undefined : outcome,
          client: client.trim() || undefined,
          cursor: pageParam,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const rows = calls.data?.pages.flatMap((page) => page.calls) ?? [];

  return (
    <>
      <PageTitle title="Calls">
        <Button variant="outline" size="sm" onClick={() => void calls.refetch()}>
          <RefreshCw
            className={calls.isFetching && !calls.isFetchingNextPage ? "animate-spin" : ""}
          />
          Refresh
        </Button>
      </PageTitle>
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={provider} onValueChange={setProvider}>
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
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-36" aria-label="Outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any outcome</SelectItem>
            <SelectItem value="true">Succeeded</SelectItem>
            <SelectItem value="false">Failed</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative">
          <User
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="w-48 pl-9"
            placeholder="Client name"
            aria-label="Client name"
            value={client}
            onChange={(event) => setClient(event.target.value)}
          />
        </div>
      </div>

      {calls.error ? (
        <QueryError error={calls.error} />
      ) : (
        <div
          className={`transition-opacity ${calls.isFetching && !calls.isFetchingNextPage ? "opacity-60" : ""}`}
        >
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sent</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Query</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Queued</TableHead>
                  <TableHead className="text-right">Retries</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((call) => (
                  <TableRow
                    key={call.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => setOpen(call)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpen(call);
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
                        label={call.ok ? "OK" : call.error?.type}
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

      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Call</SheetTitle>
            <SheetDescription>
              Timing, attempts, cost and results of one search call.
            </SheetDescription>
          </SheetHeader>
          {open && <CallDetail call={open} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
