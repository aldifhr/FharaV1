import { describe, expect, test } from "vitest";
import { Bm25, designLookup } from "@/design/designLookup";

describe("design_lookup", () => {
  test("BM25 ranks the document with the query terms first", () => {
    const index = new Bm25(["dark dashboard finance charts", "playful kids toy store", "finance banking trust blue"]);
    const ranked = index.score("finance dashboard");
    expect(ranked[0][0]).toBe(0);
    expect(ranked.map(([i]) => i)).not.toContain(1);
  });

  test("searches each table and caps the result", () => {
    const product = designLookup({ table: "product", query: "fintech banking app" });
    expect(product.ok).toBe(true);
    expect(product.text).toMatch(/product result/);
    const ux = designLookup({ table: "ux", query: "focus keyboard navigation", limit: 50 });
    expect(ux.ok).toBe(true);
    expect(ux.text.length).toBeLessThanOrEqual(4_000);
    expect(designLookup({ table: "color", query: "saas" }).text).toMatch(/primary: #/);
  });

  test("rejects a bad table or empty query, reports no match plainly", () => {
    expect(designLookup({ table: "fonts", query: "x" }).isError).toBe(true);
    expect(designLookup({ table: "style", query: "" }).isError).toBe(true);
    expect(designLookup({ table: "style", query: "zzqqxx" }).text).toMatch(/No style match/);
  });
});
