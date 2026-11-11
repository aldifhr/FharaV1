import { describe, expect, it, vi } from "vitest";
import {
  listOpencodeModels,
  parseOpencodeModelList,
  type SpawnImpl,
} from "@/execution/nativeProvider";
import {
  CATALOG_STALE_MS,
  pollOpencodeCatalog,
  shouldRefreshCatalog,
} from "@/services/opencodeCatalog";

const SECRET = "sk-test-SECRET-value-123456";

describe("opencode model list", () => {
  it("keeps only provider/model lines, de-duplicates and drops noise", () => {
    const stdout = [
      "opencode/beam-free",
      "opencode/minimax-m3.1-flash-free",
      "opencode/beam-free",
      "",
      "some banner text",
      "9router/muse",
    ].join("\n");
    expect(parseOpencodeModelList(stdout)).toEqual([
      "opencode/beam-free",
      "opencode/minimax-m3.1-flash-free",
      "9router/muse",
    ]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 900 }, (_, i) => `p/model-${i}`);
    expect(parseOpencodeModelList(many.join("\n")).length).toBe(500);
  });

  it("asks the CLI with a scrubbed env and no credential in argv", async () => {
    let seen: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const spawnImpl: SpawnImpl = async (_cmd, args, opts) => {
      seen = { args, env: opts.env };
      return { stdout: "opencode/beam-free\n", stderr: "", code: 0 };
    };
    const result = await listOpencodeModels({ spawnImpl });
    expect(result.available).toBe(true);
    expect(result.models).toEqual(["opencode/beam-free"]);
    expect(seen?.args).toEqual(["models"]);
    expect(seen?.env?.CONVEX_SERVICE_TOKEN).toBeUndefined();
    expect(seen?.env?.PROVIDER_ENCRYPTION_KEY).toBeUndefined();
    expect(JSON.stringify(seen?.args)).not.toContain(SECRET);
  });

  it("a missing CLI is a value, not an exception", async () => {
    const spawnImpl: SpawnImpl = async () => {
      throw new Error("spawn opencode ENOENT");
    };
    const result = await listOpencodeModels({ spawnImpl });
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("ENOENT");
  });

  it("a non-zero exit is reported with its stderr", async () => {
    const spawnImpl: SpawnImpl = async () => ({
      stdout: "",
      stderr: "boom",
      code: 1,
    });
    const result = await listOpencodeModels({ spawnImpl });
    expect(result.available).toBe(false);
    expect(result.error).toContain("boom");
  });
});

describe("catalog refresh decision", () => {
  const now = 1_700_000_000_000;
  it("refreshes when the UI asked, when nothing was reported, and when the report is stale", () => {
    expect(
      shouldRefreshCatalog(
        { hasCatalog: true, available: true, updatedAt: now - 10_000, refreshRequestedAt: now },
        now
      )
    ).toBe(true);
    // A request that lands in the same millisecond as the report is still a request.
    expect(
      shouldRefreshCatalog(
        { hasCatalog: true, available: true, updatedAt: now, refreshRequestedAt: now },
        now
      )
    ).toBe(true);
    expect(
      shouldRefreshCatalog(
        { hasCatalog: false, available: false, updatedAt: 0, refreshRequestedAt: 0 },
        now
      )
    ).toBe(true);
    expect(
      shouldRefreshCatalog(
        { hasCatalog: true, available: true, updatedAt: now - CATALOG_STALE_MS - 1, refreshRequestedAt: 0 },
        now
      )
    ).toBe(true);
  });

  it("leaves a fresh catalog alone", () => {
    expect(
      shouldRefreshCatalog(
        { hasCatalog: true, available: true, updatedAt: now - 1_000, refreshRequestedAt: 0 },
        now
      )
    ).toBe(false);
  });
});

describe("pollOpencodeCatalog", () => {
  function deps(state: { refreshRequestedAt: number; updatedAt: number; hasCatalog: boolean }) {
    const report = vi.fn(async () => ({ models: 1 }));
    const api = {
      getOpencodeModelState: vi.fn(async () => ({
        hasCatalog: state.hasCatalog,
        available: true,
        updatedAt: state.updatedAt,
        refreshRequestedAt: state.refreshRequestedAt,
      })),
      reportOpencodeModels: report,
    };
    const listModels = vi.fn(async () => ({ models: ["opencode/beam-free"], available: true }));
    return {
      api,
      report,
      listModels,
      deps: {
        api: api as never,
        workerId: "w1",
        hostname: "alpha",
        log: () => undefined,
        listModels,
        // Plan 038 detects before listing; inject it so the poll is deterministic.
        detect: async () => ({ installed: true, checkedAt: 0 }),
      },
    };
  }

  it("reports the list when a refresh was requested", async () => {
    const { deps: d, report, listModels } = deps({ hasCatalog: true, updatedAt: 1, refreshRequestedAt: 2 });
    const ran = await pollOpencodeCatalog(d);
    expect(ran).toBe(true);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "w1",
        hostname: "alpha",
        models: ["opencode/beam-free"],
        available: true,
      })
    );
  });

  it("does not touch the CLI when the catalog is fresh", async () => {
    const { deps: d, report, listModels } = deps({
      hasCatalog: true,
      updatedAt: Date.now(),
      refreshRequestedAt: 0,
    });
    const ran = await pollOpencodeCatalog(d);
    expect(ran).toBe(false);
    expect(listModels).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("a failed poll is logged, never thrown", async () => {
    const api = {
      getOpencodeModelState: vi.fn(async () => {
        throw new Error("backend down");
      }),
      reportOpencodeModels: vi.fn(async () => ({ models: 0 })),
    };
    const logs: unknown[] = [];
    const ran = await pollOpencodeCatalog({
      api: api as never,
      workerId: "w1",
      log: (...args: unknown[]) => logs.push(args),
    });
    expect(ran).toBe(false);
    expect(logs.length).toBe(1);
  });
});
