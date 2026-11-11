import { describe, expect, it } from "vitest";
import { METRIC_DOCS } from "./metric-docs";

describe("METRIC_DOCS", () => {
  it("explains every metric fully, with code spans that open and close", () => {
    for (const [id, doc] of Object.entries(METRIC_DOCS)) {
      const texts = [doc.title, doc.meaning, ...doc.logic, doc.source];
      expect(
        texts.every((text) => text.trim() !== ""),
        id,
      ).toBe(true);
      expect(doc.logic.length, id).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.split("`").length % 2, `${id}: ${text}`).toBe(1);
      }
    }
  });

  it("states the thresholds the code applies", () => {
    expect(METRIC_DOCS.health.logic.join(" ")).toContain("last 3 calls in a row");
    expect(METRIC_DOCS.health.logic.join(" ")).toContain("fewer than 80%");
    expect(METRIC_DOCS.medianLatency.logic.join(" ")).toContain("last 20");
  });
});
