import { describe, expect, it, vi } from "vitest";
import { parseCodexModelRows, pollCodexCatalog, shouldRefreshCodexCatalog } from "@/services/codexCatalog";

describe("Codex model catalog", () => {
  it("keeps visible valid ids, de-duplicates, and drops hidden or malformed rows", () => {
    expect(parseCodexModelRows([
      { id: "gpt-6-luna" }, { id: "gpt-6-luna" }, { id: "gpt-internal", hidden: true },
      { id: "bad model" }, { model: "gpt-5.6-terra" }, null,
    ])).toEqual(["gpt-6-luna", "gpt-5.6-terra"]);
  });

  it("refreshes missing/stale catalogs and explicit refreshes", () => {
    expect(shouldRefreshCodexCatalog({ hasCatalog: false, updatedAt: 0, refreshRequestedAt: 0 }, 10)).toBe(true);
    expect(shouldRefreshCodexCatalog({ hasCatalog: true, updatedAt: 10, refreshRequestedAt: 10 }, 10)).toBe(true);
    expect(shouldRefreshCodexCatalog({ hasCatalog: true, updatedAt: 10, refreshRequestedAt: 0 }, 11)).toBe(false);
  });

  it("publishes the CLI result when the backend requested refresh", async () => {
    const reportCodexModels = vi.fn(async () => ({ models: 2 }));
    const listModels = vi.fn(async () => ({ models: ["gpt-6-luna", "gpt-5.6-terra"], available: true }));
    const ran = await pollCodexCatalog({
      api: {
        getCodexModelState: async () => ({ hasCatalog: true, updatedAt: 1, refreshRequestedAt: 2 }),
        reportCodexModels,
      } as never,
      workerId: "w1", hostname: "alpha", log: () => undefined, listModels, now: () => 3,
    });
    expect(ran).toBe(true);
    expect(reportCodexModels).toHaveBeenCalledWith(expect.objectContaining({ workerId: "w1", models: ["gpt-6-luna", "gpt-5.6-terra"], available: true }));
  });
});
