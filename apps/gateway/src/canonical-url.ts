const TRACKING = /^(utm_\w+|fbclid|gclid|msclkid|ref|ref_src|mc_cid|mc_eid)$/i;

/**
 * The same string for the same page, however a provider links to it: https,
 * lower-case host without `www.`, `m.` or `amp.`, no trailing slash, no
 * fragment, no tracking parameters, the remaining parameters sorted. It is for
 * matching results across providers, not for fetching: use the result's `url`.
 * Kept free of dependencies so the dashboard uses the very same rule.
 */
export function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.href;
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|amp)\./, "");
  const port = parsed.port ? `:${parsed.port}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  const query = new URLSearchParams(
    [...parsed.searchParams]
      .filter(([name]) => !TRACKING.test(name))
      .toSorted(([a], [b]) => a.localeCompare(b)),
  ).toString();
  return `https://${host}${port}${path}${query ? `?${query}` : ""}`;
}
