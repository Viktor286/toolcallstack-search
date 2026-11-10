/**
 * A provider keeps the same colour on every chart, whatever else is shown: the
 * slot comes from this fixed order, never from its position in a result set.
 * A provider added later takes the next slot; past seven it shares the neutral.
 */
const ORDER = ["brave", "exa", "fastcrw", "firecrawl", "parallel", "tavily", "you"];

export function providerColor(id: string): string {
  const slot = ORDER.indexOf(id);
  return slot === -1 ? "var(--series-other)" : `var(--series-${slot + 1})`;
}

export function byProviderOrder(a: string, b: string): number {
  const left = ORDER.indexOf(a);
  const right = ORDER.indexOf(b);
  return (
    (left === -1 ? ORDER.length : left) - (right === -1 ? ORDER.length : right) ||
    a.localeCompare(b)
  );
}
