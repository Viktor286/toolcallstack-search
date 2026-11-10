import { Check, Copy, Download } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { downloadJson } from "@/lib/playground";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
// Past this size colouring costs more than it helps; the text is shown plain.
const HIGHLIGHT_LIMIT = 300_000;

function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const [whole, string, colon, literal] = match;
    if (string && colon) {
      nodes.push(
        <span key={index} className="font-medium text-foreground">
          {string}
        </span>,
        colon,
      );
    } else {
      const color = string
        ? "var(--code-string)"
        : literal
          ? "var(--code-literal)"
          : "var(--code-number)";
      nodes.push(
        <span key={index} style={{ color }}>
          {whole}
        </span>,
      );
    }
    last = index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Copies text and confirms it in place for a moment. */
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string | (() => string);
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {state === "done" ? <Check /> : <Copy />}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}

export function DownloadButton({
  name,
  value,
  label = "Download",
}: {
  name: string | (() => string);
  value: unknown;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => downloadJson(typeof name === "function" ? name() : name, value)}
    >
      <Download />
      {label}
    </Button>
  );
}

/** Scrollable, coloured code; long lines wrap, keeping their indentation as typed. Pass `value` for JSON, or `text` for anything else. */
export function CodeBlock({
  value,
  text,
  className = "max-h-[32rem]",
}: {
  value?: unknown;
  text?: string;
  className?: string;
}) {
  const source = useMemo(() => text ?? JSON.stringify(value, null, 2) ?? "", [text, value]);
  const body = useMemo(
    () => (text === undefined && source.length <= HIGHLIGHT_LIMIT ? highlight(source) : source),
    [text, source],
  );
  return (
    <pre
      className={`overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap ${className}`}
      tabIndex={0}
    >
      {body}
    </pre>
  );
}
