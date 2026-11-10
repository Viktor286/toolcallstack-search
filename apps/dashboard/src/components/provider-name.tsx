import { providerColor } from "@/lib/providers";

/** A provider's name with its chart colour beside it, so charts and tables read as one system. */
export function ProviderName({ id, label }: { id: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: providerColor(id) }} />
      {label ?? id}
    </span>
  );
}
