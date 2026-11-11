import { CalendarClock, CalendarOff, Copy as Shared, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SearchResponse } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { hostOf } from "@/lib/playground";
import { isWebUrl } from "../../../gateway/src/canonical-url.ts";

interface Props {
  results: SearchResponse["results"];
  /** Other responses that returned the same page, when several are being compared. */
  alsoIn?: (url: string) => string[];
}

export function ResultList({ results, alsoIn }: Props) {
  if (results.length === 0) return <p className="text-sm text-muted-foreground">No results.</p>;
  return (
    <ol className="space-y-4">
      {results.map((result) => {
        const others = alsoIn?.(result.url) ?? [];
        return (
          <li key={`${result.position}-${result.url}`} className="flex gap-3 text-sm">
            <span className="w-5 shrink-0 pt-px text-right text-muted-foreground tabular-nums">
              {result.position}
            </span>
            <div className="min-w-0 flex-1">
              {/* Calls logged before the gateway dropped such links can still hold one. */}
              {isWebUrl(result.url) ? (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {result.title || "(untitled)"}
                </a>
              ) : (
                <span className="font-medium">{result.title || "(untitled)"}</span>
              )}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1" title={result.url}>
                  <Globe className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{hostOf(result.url)}</span>
                </span>
                {result.publishedAt ? (
                  <span
                    className="inline-flex items-center gap-1"
                    title={`As reported by the provider: ${result.publishedRaw ?? ""}`}
                  >
                    <CalendarClock className="size-3 shrink-0" aria-hidden />
                    {dateTime(result.publishedAt)}
                    {result.publishedPrecision !== "datetime" &&
                      ` (${result.publishedPrecision} precision)`}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <CalendarOff className="size-3 shrink-0" aria-hidden />
                    No publish date
                  </span>
                )}
                {result.score !== null && (
                  <span className="tabular-nums">score {result.score.toFixed(2)}</span>
                )}
                {result.source === "news" && <Badge variant="outline">news</Badge>}
              </div>
              {result.snippet && (
                <p className="mt-1 line-clamp-3 text-muted-foreground">{result.snippet}</p>
              )}
              {others.length > 0 && (
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Shared className="size-3 shrink-0" aria-hidden />
                  Also returned by {others.join(", ")}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
