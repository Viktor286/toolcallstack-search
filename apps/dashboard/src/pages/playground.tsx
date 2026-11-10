import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  FileJson,
  Info,
  Search,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { CodeBlock, CopyButton, DownloadButton } from "@/components/json-view";
import { Comparison } from "@/components/playground/comparison";
import { ResponseCard, ResponseSkeleton } from "@/components/playground/response-card";
import { ProviderName } from "@/components/provider-name";
import { PageTitle, QueryError } from "@/components/query-state";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  getApiKey,
  type BatchResponse,
  type ProviderInfo,
  type SearchResponse,
} from "@/lib/api";
import {
  buildRequest,
  curlCommand,
  formFromParams,
  formToParams,
  normalizeUrl,
  parseOptions,
  sharedResults,
  snapshot,
  snapshotName,
  summarize,
  unsupportedParams,
  type PlaygroundForm,
  type PlaygroundRequest,
} from "@/lib/playground";

const EXAMPLES: { label: string; patch: Partial<PlaygroundForm> }[] = [
  {
    label: "Breaking news, past day",
    patch: { query: "Federal Reserve interest rate decision", topic: "news", freshness: "day" },
  },
  {
    label: "Technical question",
    patch: { query: "Postgres connection pooling best practices", topic: "general" },
  },
  {
    label: "One site only",
    patch: { query: "transformer architecture", includeDomains: "arxiv.org" },
  },
  {
    label: "Past week, 10 results",
    patch: { query: "open source LLM releases", freshness: "week", maxResults: 10 },
  },
];

interface Run {
  request: PlaygroundRequest;
  /** The response body exactly as the gateway returned it. */
  body: unknown;
  responses: SearchResponse[];
}

function priceLabel(pricing: ProviderInfo["pricing"]): string | null {
  if (pricing?.perRequestUsd !== undefined) return `$${pricing.perRequestUsd} / request`;
  if (pricing?.perCreditUsd !== undefined) return `$${pricing.perCreditUsd} / credit`;
  return null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function PlaygroundPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderInfo[] }>("/v1/providers"),
  });
  const all = providers.data?.providers ?? [];
  const configured = all.filter((provider) => provider.configured);

  // The address bar seeds the form once; it is rewritten on every run.
  const [stored, setStored] = useState<PlaygroundForm>(() => formFromParams(searchParams));
  const [advanced, setAdvanced] = useState(
    () => formToParams({ ...stored, query: "", providers: [], topic: "general" }).size > 1,
  );
  const [view, setView] = useState("parsed");

  // Until the user picks, the first configured provider is selected.
  const chosen = stored.providers.filter((id) => configured.some((p) => p.id === id));
  const selected = chosen.length > 0 ? chosen : configured.slice(0, 1).map((p) => p.id);
  const form = useMemo(() => ({ ...stored, providers: selected }), [stored, selected.join(",")]);
  const patch = (change: Partial<PlaygroundForm>) => setStored((old) => ({ ...old, ...change }));

  const request = useMemo(() => buildRequest(form), [form]);
  const selectedInfo = configured.filter((provider) => selected.includes(provider.id));
  const ignored = selectedInfo
    .map((provider) => ({ provider, params: unsupportedParams(provider, request.body) }))
    .filter((entry) => entry.params.length > 0);
  const optionErrors = Object.fromEntries(
    selected.map((id) => [id, parseOptions(form.options[id]).error]),
  );
  const ready =
    form.query.trim() !== "" && selected.length > 0 && !Object.values(optionErrors).some(Boolean);

  const search = useMutation({
    mutationFn: async (sent: PlaygroundRequest): Promise<Run> => {
      const body = await api<SearchResponse | BatchResponse>(sent.path, sent.body);
      return { request: sent, body, responses: "responses" in body ? body.responses : [body] };
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
    if (!ready || search.isPending) return;
    setSearchParams(formToParams(form), { replace: true });
    search.mutate(request);
  };

  const toggle = (id: string) =>
    patch({
      providers: selected.includes(id) ? selected.filter((p) => p !== id) : [...selected, id],
    });

  const run = search.data;
  const shared = useMemo(() => sharedResults(run?.responses ?? []), [run]);
  const summaries = useMemo(
    () => (run?.responses ?? []).map((response) => summarize(response, shared)),
    [run, shared],
  );
  const origin = window.location.origin;
  const names = Object.fromEntries(all.map((provider) => [provider.id, provider.name]));

  if (providers.error) return <QueryError error={providers.error} />;

  return (
    <>
      <PageTitle title="Playground" />
      <p className="-mt-3 mb-5 max-w-3xl text-sm text-muted-foreground">
        Send one query to any provider, or to several at the same instant, and compare what comes
        back: results, publish dates, where the time went and what it cost. The request on the right
        is exactly what the page sends, ready to copy into your own code.
      </p>

      <div className="mb-8 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card className="min-w-0">
          <CardContent>
            <form onSubmit={submit} className="space-y-5">
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-0 flex-1 basis-64">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    className="pl-9"
                    placeholder="Search the web…"
                    aria-label="Query"
                    autoFocus
                    value={form.query}
                    onChange={(event) => patch({ query: event.target.value })}
                  />
                </div>
                <Button type="submit" disabled={!ready || search.isPending}>
                  <Search />
                  {search.isPending ? "Searching…" : "Search"}
                </Button>
              </div>

              {!form.query && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Try:</span>
                  {EXAMPLES.map((example) => (
                    <Button
                      key={example.label}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        patch(example.patch);
                        if (example.patch.includeDomains) setAdvanced(true);
                      }}
                    >
                      {example.label}
                    </Button>
                  ))}
                </div>
              )}

              <fieldset>
                <legend className="mb-2 flex w-full items-baseline justify-between text-xs text-muted-foreground">
                  <span>Providers</span>
                  {configured.length > 1 && (
                    <button
                      type="button"
                      className="underline-offset-4 hover:underline"
                      onClick={() =>
                        patch({
                          providers:
                            selected.length === configured.length
                              ? configured.slice(0, 1).map((p) => p.id)
                              : configured.map((p) => p.id),
                        })
                      }
                    >
                      {selected.length === configured.length ? "Select one" : "Select all"}
                    </button>
                  )}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {all.map((provider) => {
                    const on = selected.includes(provider.id);
                    const price = priceLabel(provider.pricing);
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        aria-pressed={on}
                        disabled={!provider.configured}
                        title={
                          provider.configured
                            ? `Up to ${provider.maxResults} results per call`
                            : `Set ${provider.envVar} on the gateway to use ${provider.name}`
                        }
                        onClick={() => toggle(provider.id)}
                        className={`rounded-md border px-3 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 ${
                          on ? "border-foreground/40 bg-secondary" : "hover:bg-accent"
                        }`}
                      >
                        <span className="flex items-center gap-2 font-medium">
                          <ProviderName id={provider.id} label={provider.name} />
                          {on && <Check className="size-3.5" aria-hidden />}
                        </span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {provider.configured ? (price ?? "price not set") : "no API key"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {providers.data && configured.length === 0 && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No provider has an API key yet. Add one to the gateway's environment and restart
                    it.
                  </p>
                )}
              </fieldset>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="Topic">
                  <Select
                    value={form.topic}
                    onValueChange={(value) => patch({ topic: value as PlaygroundForm["topic"] })}
                  >
                    <SelectTrigger className="w-full" aria-label="Topic">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="general">General</SelectItem>
                      <SelectItem value="news">News</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Published within">
                  <Select
                    value={form.freshness}
                    onValueChange={(value) => patch({ freshness: value })}
                  >
                    <SelectTrigger className="w-full" aria-label="Published within">
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
                </Field>
                <Field label="Results per provider">
                  <Select
                    value={String(form.maxResults)}
                    onValueChange={(value) => patch({ maxResults: Number(value) })}
                  >
                    <SelectTrigger className="w-full" aria-label="Results per provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...new Set([3, 5, 10, 20, form.maxResults])]
                        .toSorted((a, b) => a - b)
                        .map((count) => (
                          <SelectItem key={count} value={String(count)}>
                            {count}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced((open) => !open)}
                >
                  <SlidersHorizontal />
                  More parameters
                  <ChevronDown className={`transition-transform ${advanced ? "rotate-180" : ""}`} />
                </Button>
                {advanced && (
                  <div className="mt-3 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Only these domains">
                        <Input
                          placeholder="reuters.com, ft.com"
                          value={form.includeDomains}
                          onChange={(event) => patch({ includeDomains: event.target.value })}
                        />
                      </Field>
                      <Field label="Never these domains">
                        <Input
                          placeholder="pinterest.com"
                          value={form.excludeDomains}
                          onChange={(event) => patch({ excludeDomains: event.target.value })}
                        />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Field label="Published from">
                        <Input
                          type="date"
                          value={form.startDate}
                          onChange={(event) => patch({ startDate: event.target.value })}
                        />
                      </Field>
                      <Field label="Published until">
                        <Input
                          type="date"
                          value={form.endDate}
                          onChange={(event) => patch({ endDate: event.target.value })}
                        />
                      </Field>
                      <Field label="Country (2 letters)">
                        <Input
                          placeholder="US"
                          maxLength={2}
                          value={form.country}
                          onChange={(event) => patch({ country: event.target.value })}
                        />
                      </Field>
                    </div>
                    <Label className="flex items-center gap-2 font-normal">
                      <Checkbox
                        checked={form.includeRaw}
                        onCheckedChange={(checked) => patch({ includeRaw: checked === true })}
                      />
                      Also return each provider's untouched response body
                    </Label>

                    {selectedInfo.map((provider) => (
                      <div key={provider.id} className="space-y-1.5">
                        <Label
                          htmlFor={`options-${provider.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {provider.name} options (JSON, merged into its request as-is)
                        </Label>
                        <textarea
                          id={`options-${provider.id}`}
                          rows={2}
                          spellCheck={false}
                          placeholder="{}"
                          aria-invalid={Boolean(optionErrors[provider.id])}
                          value={form.options[provider.id] ?? ""}
                          onChange={(event) =>
                            patch({
                              options: { ...form.options, [provider.id]: event.target.value },
                            })
                          }
                          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
                        />
                        {optionErrors[provider.id] && (
                          <p className="text-xs text-destructive">{optionErrors[provider.id]}</p>
                        )}
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {provider.notes.map((note) => (
                            <li key={note} className="flex gap-1.5">
                              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                              <span>{note.replaceAll("`", "")}</span>
                            </li>
                          ))}
                          <li>
                            <a
                              href={provider.docs}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-4"
                            >
                              {provider.name} documentation
                            </a>
                          </li>
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {ignored.length > 0 && (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {ignored.map(({ provider, params }) => (
                    <li key={provider.id} className="flex gap-2">
                      <TriangleAlert
                        className="mt-0.5 size-4 shrink-0"
                        style={{ color: "var(--status-warning)" }}
                        aria-hidden
                      />
                      <span>
                        {provider.name} has no {params.join(", ")} parameter; the gateway will leave
                        it out and say so in the response.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {selected.length > 1 && (
                <p className="text-sm text-muted-foreground">
                  The query goes to {selected.length} providers at the same instant; each is billed.
                </p>
              )}
            </form>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Request
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-normal">
                POST {request.path}
              </code>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="json">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                  <TabsTrigger value="curl">curl</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="json" className="space-y-2">
                <CodeBlock value={request.body} className="max-h-80" />
                <CopyButton text={() => JSON.stringify(request.body, null, 2)} />
              </TabsContent>
              <TabsContent value="curl" className="space-y-2">
                <CodeBlock
                  text={curlCommand(request, origin, Boolean(getApiKey()))}
                  className="max-h-80"
                />
                <CopyButton text={() => curlCommand(request, origin, Boolean(getApiKey()))} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {search.error && <QueryError error={search.error} />}

      {search.isPending && (
        <div className={`grid gap-4 ${selected.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {selectedInfo.map((provider) => (
            <ResponseSkeleton key={provider.id} id={provider.id} label={provider.name} />
          ))}
        </div>
      )}

      {run && !search.isPending && (
        <Tabs value={view} onValueChange={setView}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight">Response</h2>
              <TabsList>
                <TabsTrigger value="parsed">Parsed</TabsTrigger>
                <TabsTrigger value="json">
                  <FileJson />
                  JSON
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton
                label="Copy link"
                text={() => `${origin}${window.location.pathname}?${formToParams(form)}`}
              />
              <DownloadButton
                label="Export snapshot"
                name={() => snapshotName(String(run.request.body.query ?? ""))}
                value={snapshot(run.request, run.body, origin)}
              />
            </div>
          </div>

          <TabsContent value="parsed" className="space-y-4 pt-2">
            {run.responses.length > 1 && (
              <Card className="min-w-0">
                <CardContent>
                  <Comparison responses={run.responses} summaries={summaries} names={names} />
                </CardContent>
              </Card>
            )}
            <div
              className={`grid items-start gap-4 ${run.responses.length > 1 ? "lg:grid-cols-2" : ""}`}
            >
              {run.responses.map((response, index) => (
                <ResponseCard
                  key={response.id}
                  name={names[response.provider]}
                  response={response}
                  summary={summaries[index]!}
                  alsoIn={
                    run.responses.length > 1
                      ? (url) =>
                          (shared.get(normalizeUrl(url)) ?? []).filter(
                            (label) => label !== response.label,
                          )
                      : undefined
                  }
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="json" className="pt-2">
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    Request sent
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-normal">
                      POST {run.request.path}
                    </code>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <CopyButton text={() => JSON.stringify(run.request.body, null, 2)} />
                  <CodeBlock value={run.request.body} className="max-h-[40rem]" />
                </CardContent>
              </Card>
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle className="text-base">Response body</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <CopyButton text={() => JSON.stringify(run.body, null, 2)} />
                  <CodeBlock value={run.body} className="max-h-[40rem]" />
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
