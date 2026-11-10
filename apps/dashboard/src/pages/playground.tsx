import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ResultList } from "@/components/call-detail";
import { PhaseBar } from "@/components/charts/phase-bar";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, type BatchResponse, type ProviderInfo, type SearchResponse } from "@/lib/api";
import { callCost, ms, usd } from "@/lib/format";

export function PlaygroundPage() {
  const queryClient = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderInfo[] }>("/v1/providers"),
  });
  const configured = providers.data?.providers.filter((provider) => provider.configured) ?? [];

  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [topic, setTopic] = useState("general");
  const [freshness, setFreshness] = useState("any");
  const [maxResults, setMaxResults] = useState("5");
  // Until the user picks, the first configured provider is selected.
  const selected = chosen ?? configured.slice(0, 1).map((provider) => provider.id);

  const search = useMutation({
    mutationFn: async (): Promise<SearchResponse[]> => {
      const body = {
        query: text.trim(),
        topic,
        maxResults: Number(maxResults),
        ...(freshness === "any" ? {} : { freshness }),
      };
      if (selected.length === 1) {
        return [await api<SearchResponse>("/v1/search", { ...body, provider: selected[0] })];
      }
      return (await api<BatchResponse>("/v1/search/batch", { ...body, providers: selected }))
        .responses;
    },
    onSettled: () => {
      // New calls change the overview, the call list and usage.
      for (const key of ["calls", "status", "stats", "usage", "providers"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() && selected.length > 0) search.mutate();
  };

  if (providers.error) return <QueryError error={providers.error} />;

  return (
    <>
      <PageTitle title="Playground" />
      <form onSubmit={submit} className="mb-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-0 flex-1 basis-64"
            placeholder="Search the web…"
            aria-label="Query"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            type="submit"
            disabled={!text.trim() || selected.length === 0 || search.isPending}
          >
            {search.isPending ? "Searching…" : "Search"}
          </Button>
        </div>
        <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
          <legend className="sr-only">Providers</legend>
          {configured.map((provider) => (
            <Label key={provider.id} className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={selected.includes(provider.id)}
                onCheckedChange={(checked) =>
                  setChosen(
                    checked
                      ? [...selected, provider.id]
                      : selected.filter((id) => id !== provider.id),
                  )
                }
              />
              <ProviderName id={provider.id} label={provider.name} />
            </Label>
          ))}
          {providers.data && configured.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No provider has an API key yet. Add one to the gateway's environment and restart it.
            </p>
          )}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Select value={topic} onValueChange={setTopic}>
            <SelectTrigger className="w-32" aria-label="Topic">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">General</SelectItem>
              <SelectItem value="news">News</SelectItem>
            </SelectContent>
          </Select>
          <Select value={freshness} onValueChange={setFreshness}>
            <SelectTrigger className="w-36" aria-label="Freshness">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any time</SelectItem>
              <SelectItem value="hour">Past hour</SelectItem>
              <SelectItem value="day">Past day</SelectItem>
              <SelectItem value="week">Past week</SelectItem>
              <SelectItem value="month">Past month</SelectItem>
              <SelectItem value="year">Past year</SelectItem>
            </SelectContent>
          </Select>
          <Select value={maxResults} onValueChange={setMaxResults}>
            <SelectTrigger className="w-32" aria-label="Results per provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["3", "5", "10", "20"].map((count) => (
                <SelectItem key={count} value={count}>
                  {count} results
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selected.length > 1 && (
          <p className="text-sm text-muted-foreground">
            The query goes to {selected.length} providers at the same instant; each is billed.
          </p>
        )}
      </form>

      {search.error && <QueryError error={search.error} />}
      {search.data && (
        <div className={`grid gap-4 ${search.data.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {search.data.map((response) => {
            const cost = callCost(response.usage);
            return (
              <Card key={response.id}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                    <ProviderName id={response.provider} label={response.label} />
                    <StatusLabel
                      kind={response.ok ? "ok" : "failed"}
                      label={
                        response.ok ? `${response.results.length} results` : response.error?.type
                      }
                    />
                  </CardTitle>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground tabular-nums">
                    <span>{ms(response.timing.totalMs)}</span>
                    <span>
                      {cost === null ? "cost unknown" : `${usd(cost)} ${response.usage.costSource}`}
                    </span>
                    {response.retries.count > 0 && <span>{response.retries.count} retries</span>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {response.error && (
                    <p className="text-sm break-words text-muted-foreground">
                      {response.error.message}
                    </p>
                  )}
                  {response.warnings.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {response.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  {response.timing.phases && (
                    <PhaseBar queuedMs={response.timing.queuedMs} phases={response.timing.phases} />
                  )}
                  {response.ok && <ResultList results={response.results} />}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
