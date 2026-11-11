import { ExternalLink } from "lucide-react";
import type { ProviderInfo } from "@/lib/api";

/** Opens the provider's own web console, where its account, keys and billing are managed. */
export function ConsoleLink({ info }: { info: ProviderInfo | undefined }) {
  if (!info?.console) return null;
  return (
    <a
      href={info.console}
      target="_blank"
      rel="noreferrer"
      className="inline-flex text-muted-foreground hover:text-foreground"
      title={`Open the ${info.name} console`}
      aria-label={`Open the ${info.name} console`}
    >
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}
