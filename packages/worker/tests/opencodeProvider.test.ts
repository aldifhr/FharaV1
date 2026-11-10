import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectOpencode,
  findOpencodeBinary,
  opencodeGateFor,
  parseOpencodeVersion,
  parseWhereOutput,
  probeOpencode,
  shellSafeCommand,
} from "@/execution/opencodeDetect";
import type { SpawnImpl } from "@/execution/nativeProvider";
import { resolveForAgent, TaskLlmResolver, type PoolConnection, type PoolModel } from "@/llm/resolver";
import { ProviderHealthRegistry } from "@/llm/health";
import { fixedRotationCursor, InMemoryRotationCursor } from "@/llm/roundRobin";
import { orderedChatPairs } from "@/api/convex/lib/chat/llm";
import type { PoolConnectionPayload } from "@/api/convex/lib/llmResolver";
import { refreshOpencodeCatalog, pollOpencodeCatalog } from "@/services/opencodeCatalog";

/**
 * Plan 038: OpenCode as a provider. Detection parsing, the chain that skips
 * OpenCode for API calls (chat and every backend call), the worker route
 * that runs an OpenCode entry natively or skips it, and the isolation guard.
 */

// ---------- detection ----------

describe("parseOpencodeVersion", () => {
  it("reads a bare semver", () => {
    expect(parseOpencodeVersion("1.19.5\n")).toBe("1.19.5");
  });
  it("reads a prefixed version and strips ANSI codes", () => {
    expect(parseOpencodeVersion("\u001b[1mopencode\u001b[0m v0.15.3")).toBe("0.15.3");
    expect(parseOpencodeVersion("opencode version 2.0.0-beta.1")).toBe("2.0.0-beta.1");
  });
  it("falls back to the first line, and undefined for empty output", () => {
    expect(parseOpencodeVersion("dev build\nmore")).toBe("dev build");
    expect(parseOpencodeVersion("   ")).toBeUndefined();
  });
});

describe("parseWhereOutput (Windows)", () => {
  it("prefers the runnable .cmd wrapper over the extensionless npm shim", () => {
    const out = "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd\r\n";
    expect(parseWhereOutput(out)).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd");
  });
  it("ignores the not-found notice", () => {
    expect(parseWhereOutput("INFO: Could not find files for the given pattern(s).\r\n")).toBeUndefined();
  });
});

describe("findOpencodeBinary", () => {
  it("finds opencode.cmd on a Windows Path with PATHEXT", async () => {
    const files = new Set(["D:\\tools\\npm\\opencode", "D:\\tools\\npm\\opencode.cmd"]);
    const found = await findOpencodeBinary({
      command: "opencode",
      platform: "win32",
      env: { Path: "C:\\Windows;\"D:\\tools\\npm\"", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      isExecutable: async (file) => files.has(file),
      spawnImpl: async () => ({ stdout: "", stderr: "", code: 1 }),
    });
    expect(found).toBe("D:\\tools\\npm\\opencode.cmd");
  });

  it("asks `where` on Windows when the PATH scan misses", async () => {
    const calls: string[] = [];
    const found = await findOpencodeBinary({
      command: "opencode",
      platform: "win32",
      env: { Path: "C:\\Windows" },
      isExecutable: async () => false,
      spawnImpl: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return { stdout: "C:\\npm\\opencode.cmd\r\n", stderr: "", code: 0 };
      },
    });
    expect(calls).toEqual(["where opencode"]);
    expect(found).toBe("C:\\npm\\opencode.cmd");
  });

  it("checks a configured command path directly", async () => {
    const found = await findOpencodeBinary({
      command: "/opt/oc/bin/opencode",
      platform: "linux",
      env: { PATH: "" },
      isExecutable: async (file) => file === "/opt/oc/bin/opencode",
    });
    expect(found).toBe("/opt/oc/bin/opencode");
  });

  it("returns undefined when it is nowhere", async () => {
    const found = await findOpencodeBinary({
      command: "opencode",
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      isExecutable: async () => false,
    });
    expect(found).toBeUndefined();
  });

  it("quotes a Windows path with spaces for the shell", () => {
    expect(shellSafeCommand("C:\\Program Files\\nodejs\\opencode.cmd", "win32")).toBe(
      '"C:\\Program Files\\nodejs\\opencode.cmd"'
    );
    expect(shellSafeCommand("/usr/bin/opencode", "linux")).toBe("/usr/bin/opencode");
  });
});

describe("detectOpencode", () => {
  const onPath = { platform: "linux" as const, env: { PATH: "/x" }, isExecutable: async (f: string) => f === "/x/opencode" };

  it("not found = installed false with the reason", async () => {
    const result = await detectOpencode({ command: "opencode", platform: "linux", env: { PATH: "/x" }, isExecutable: async () => false });
    expect(result.installed).toBe(false);
    expect(result.error).toMatch(/not found on PATH/);
  });

  it("found + version", async () => {
    const spawnImpl: SpawnImpl = async (cmd, args) => {
      expect([cmd, ...args]).toEqual(["/x/opencode", "--version"]);
      return { stdout: "1.19.5\n", stderr: "", code: 0 };
    };
    const result = await detectOpencode({ command: "opencode", ...onPath, spawnImpl });
    expect(result).toMatchObject({ installed: true, version: "1.19.5", path: "/x/opencode" });
    expect(result.error).toBeUndefined();
  });

  it("a hanging --version times out: installed, no version, a timeout error", async () => {
    const spawnImpl: SpawnImpl = (_cmd, _args, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: null }));
      });
    const result = await detectOpencode({ command: "opencode", ...onPath, spawnImpl, timeoutMs: 20 });
    expect(result.installed).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.error).toMatch(/timed out after 20 ms/);
  });

  it("a failing --version is installed with the error", async () => {
    const spawnImpl: SpawnImpl = async () => ({ stdout: "", stderr: "boom", code: 2 });
    const result = await detectOpencode({ command: "opencode", ...onPath, spawnImpl });
    expect(result).toMatchObject({ installed: true, error: "boom" });
  });
});

// ---------- isolation guard ----------

describe("opencodeGateFor (isolation guard)", () => {
  const detected = { installed: true, version: "1.19.5", path: "/x/opencode", checkedAt: 1 };

  it("refuses without worktree isolation", () => {
    const gate = opencodeGateFor({ detection: detected, worktreeIsolation: false, env: {} });
    expect(gate.available).toBe(false);
    expect(gate.reason).toMatch(/worktree isolation is off/);
  });

  it("allows with isolation, or with the explicit env opt-out", () => {
    expect(opencodeGateFor({ detection: detected, worktreeIsolation: true, env: {} })).toEqual({ available: true });
    expect(
      opencodeGateFor({ detection: detected, worktreeIsolation: false, env: { ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED: "1" } })
    ).toEqual({ available: true });
  });

  it("refuses when the CLI was not detected", () => {
    const gate = opencodeGateFor({
      detection: { installed: false, error: '"opencode" was not found on PATH', checkedAt: 1 },
      worktreeIsolation: true,
      env: {},
    });
    expect(gate.available).toBe(false);
    expect(gate.reason).toMatch(/not detected.*not found on PATH/);
  });
});

// ---------- the chain ----------

function model(modelId: string, position: number): PoolModel {
  return { _id: `row-${modelId}`, modelId, isAvailable: true, position } as PoolModel;
}

function conn(partial: Partial<PoolConnection> & { _id: string; name: string }): PoolConnection {
  return {
    provider: "openai-compatible",
    baseUrl: `https://${partial._id}.example/v1`,
    apiKeyEnv: "",
    apiKey: "test-key",
    priority: 10,
    weight: 100,
    models: [],
    ...partial,
  } as PoolConnection;
}

/** OpenCode at the top, then two API models: oc/a, http/x, oc/b, http/y. */
const mixedPool = () => [
  conn({ _id: "oc", name: "OpenCode", provider: "opencode", baseUrl: "", apiKey: "", models: [model("opencode/a", 0), model("opencode/b", 2)] }),
  conn({ _id: "http", name: "HTTP", models: [model("x", 1), model("y", 3)] }),
];

const chain = (r: ReturnType<typeof resolveForAgent>) => [r.primary, ...r.fallbackChain].map((e) => `${e.connectionId}/${e.model}`);

describe("API calls never see OpenCode entries", () => {
  it("resolveForAgent drops the OpenCode row by default", () => {
    const r = resolveForAgent(undefined, {}, mixedPool(), new ProviderHealthRegistry(), { rotation: fixedRotationCursor });
    expect(chain(r)).toEqual(["http/x", "http/y"]);
  });

  it("chat skips OpenCode entries, and its order equals the worker's API chain (parity)", () => {
    const pool = mixedPool();
    const payload = pool.map((c) => ({ ...c, isEnabled: true })) as unknown as PoolConnectionPayload[];
    const chat = orderedChatPairs(payload, undefined, { next: () => 0 }).map((p) => `${p.connection._id}/${p.model.modelId}`);
    expect(chat).toEqual(["http/x", "http/y"]);
    const worker = resolveForAgent(undefined, {}, pool, new ProviderHealthRegistry(), { rotation: fixedRotationCursor });
    expect(chat).toEqual(chain(worker));
  });

  it("an agent assigned to OpenCode chats on the global API order", () => {
    const payload = mixedPool().map((c) => ({ ...c, isEnabled: true })) as unknown as PoolConnectionPayload[];
    const chat = orderedChatPairs(payload, { llmProviderId: "oc" }, { next: () => 0 }).map((p) => p.model.modelId);
    expect(chat).toEqual(["x", "y"]);
  });
});

describe("executionRouteFor (the subtask route)", () => {
  const resolver = (pool = mixedPool(), mode?: "round_robin") =>
    new TaskLlmResolver(pool, new ProviderHealthRegistry(), {
      rotation: new InMemoryRotationCursor(),
      ...(mode ? { globalMode: mode } : {}),
    });

  it("an OpenCode entry at the top runs natively with that model", () => {
    const route = resolver().executionRouteFor(undefined, { available: true });
    expect(route.runtime).toBe("native-provider");
    if (route.runtime !== "native-provider") return;
    expect(route.model).toBe("opencode/a");
    expect(route.skipped).toEqual([]);
    // Auxiliary API calls keep the HTTP chain.
    expect(route.apiResolution && chain(route.apiResolution)).toEqual(["http/x", "http/y"]);
  });

  it("an unavailable OpenCode is skipped: the next API model runs, with the API rest as failover", () => {
    const route = resolver().executionRouteFor(undefined, { available: false, reason: "OpenCode CLI not detected" });
    expect(route.runtime).toBe("api");
    if (route.runtime !== "api") return;
    expect(chain(route.resolution)).toEqual(["http/x", "http/y"]);
    expect(route.skipped).toEqual([{ model: "opencode/a", reason: "OpenCode CLI not detected" }]);
  });

  it("an API model at the top runs on the API runtime, OpenCode entries left out of its failover", () => {
    const pool = [
      conn({ _id: "http", name: "HTTP", models: [model("x", 0)] }),
      conn({ _id: "oc", name: "OpenCode", provider: "opencode", baseUrl: "", apiKey: "", models: [model("opencode/a", 1)] }),
    ];
    const route = resolver(pool).executionRouteFor(undefined, { available: true });
    expect(route.runtime).toBe("api");
    if (route.runtime !== "api") return;
    expect(chain(route.resolution)).toEqual(["http/x"]);
  });

  it("only OpenCode entries, all unavailable: falls back to the worker env model", () => {
    const pool = [conn({ _id: "oc", name: "OpenCode", provider: "opencode", baseUrl: "", apiKey: "", models: [model("opencode/a", 0)] })];
    const route = resolver(pool).executionRouteFor(undefined, { available: false, reason: "isolation" });
    expect(route.runtime).toBe("api");
    if (route.runtime !== "api") return;
    expect(route.resolution.primary.connectionName).toBe("(worker env)");
    expect(route.skipped).toHaveLength(1);
  });

  it("a per-agent override pointing at OpenCode wins over the list", () => {
    const route = resolver().executionRouteFor({ llmProviderId: "oc", llmModelId: "row-opencode/b" }, { available: true });
    expect(route.runtime === "native-provider" && route.model).toBe("opencode/b");
  });

  it("round robin rotates through OpenCode and API entries alike", () => {
    const r = resolver(mixedPool(), "round_robin");
    const firsts = [0, 1, 2, 3].map(() => {
      const route = r.executionRouteFor(undefined, { available: true });
      return route.runtime === "native-provider" ? route.model : route.resolution.primary.model;
    });
    expect(firsts).toEqual(["opencode/a", "x", "opencode/b", "y"]);
  });

  it("hasOpencode tells the runner whether the list decides the runtime", () => {
    expect(resolver().hasOpencode()).toBe(true);
    expect(resolver([conn({ _id: "http", name: "HTTP", models: [model("x", 0)] })]).hasOpencode()).toBe(false);
  });
});

// ---------- the catalog loop ----------

describe("catalog loop with detection and Test", () => {
  it("reports detection with the catalog; a missing CLI skips the listing", async () => {
    const reports: unknown[] = [];
    let listed = 0;
    await refreshOpencodeCatalog({
      api: { getOpencodeModelState: async () => ({}) as never, reportOpencodeModels: async (r) => (reports.push(r), { models: 0 }) },
      workerId: "w1",
      log: () => {},
      detect: async () => ({ installed: false, error: '"opencode" was not found on PATH', checkedAt: 1 }),
      listModels: async () => ((listed += 1), { models: [], available: true }),
    });
    expect(listed).toBe(0);
    expect(reports[0]).toMatchObject({ installed: false, available: false, error: '"opencode" was not found on PATH' });
  });

  it("serves a pending Test once and reports latency", async () => {
    const tests: unknown[] = [];
    const deps = {
      api: {
        getOpencodeModelState: async () => ({
          hasCatalog: true,
          available: true,
          updatedAt: Date.now(),
          refreshRequestedAt: 0,
          testRequestedAt: Date.now(),
          testModel: "opencode/a",
        }),
        reportOpencodeModels: async () => ({ models: 0 }),
        reportOpencodeTest: async (r: unknown) => (tests.push(r), { ok: true }),
      },
      workerId: "w1",
      log: () => {},
      probe: async (m: string) => ({ ok: true, latencyMs: 42, model: m }),
    };
    expect(await pollOpencodeCatalog(deps as never)).toBe(true);
    expect(tests).toEqual([{ workerId: "w1", ok: true, latencyMs: 42, model: "opencode/a" }]);
  });
});

// ---------- live CLI (skipped when it is not installed) ----------

const LIVE_BIN = process.env.OPENCODE_LIVE_BIN ?? "/workspace/work/bin/opencode";
const LIVE_MODEL = process.env.OPENCODE_LIVE_MODEL ?? "opencode/minimax-m3.1-flash-free";
const hasLiveCli = existsSync(LIVE_BIN) && process.env.OPENCODE_LIVE !== "0";

describe.skipIf(!hasLiveCli)("live OpenCode CLI", () => {
  const env = { ...process.env, PATH: `${path.dirname(LIVE_BIN)}${path.delimiter}${process.env.PATH ?? ""}` };

  it("detects the installed CLI and its version", async () => {
    const saved = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const result = await detectOpencode({ command: "opencode", env, timeoutMs: 15_000 });
      expect(result.installed).toBe(true);
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.path).toBe(path.join(path.dirname(LIVE_BIN), "opencode"));
      console.log(`[live] opencode ${result.version} at ${result.path}`);
    } finally {
      process.env.PATH = saved;
    }
  }, 20_000);

  it("Test probe: a tiny opencode run answers", async () => {
    const saved = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const result = await probeOpencode({ command: LIVE_BIN, model: LIVE_MODEL, timeoutMs: 120_000 });
      console.log(`[live] probe ${LIVE_MODEL}: ok=${result.ok} ${result.latencyMs} ms${result.error ? ` ${result.error}` : ""}`);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
    } finally {
      process.env.PATH = saved;
    }
  }, 150_000);
});
