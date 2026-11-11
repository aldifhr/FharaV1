import { afterEach, describe, expect, it } from "vitest";
import { ENV_SCHEMA, type EnvVar, readVar, schemaDefault, setEnvIssueSink } from "@fhara/config";
import { setSettingOverrides } from "@/api/convex/lib/appSettings";
import { toolLoopEnabled } from "@/execution/toolLoopFlag";
import { loadPolicy } from "@/orchestrator/policy";

/**
 * The labelled behaviour changes after E4 (B1–B10), one describe per fix.
 * Each pins the NEW behaviour; the E1 parity oracles keep pinning every
 * read that did not change.
 */
describe("B1: ORCHESTRATOR_TOOL_LOOP honours the bool parser and the UI override", () => {
  const saved = process.env.ORCHESTRATOR_TOOL_LOOP;
  afterEach(() => {
    setSettingOverrides({});
    if (saved === undefined) delete process.env.ORCHESTRATOR_TOOL_LOOP;
    else process.env.ORCHESTRATOR_TOOL_LOOP = saved;
  });

  it("accepts 1 / true / yes / on, not only the literal \"true\"", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) expect(toolLoopEnabled({ ORCHESTRATOR_TOOL_LOOP: raw }), raw).toBe(true);
    for (const raw of ["0", "false", "off", "no"]) expect(toolLoopEnabled({ ORCHESTRATOR_TOOL_LOOP: raw }), raw).toBe(false);
    expect(toolLoopEnabled({})).toBe(false);
  });

  it("a Settings override wins over the env, and agrees with loadPolicy().toolLoop", () => {
    process.env.ORCHESTRATOR_TOOL_LOOP = "0";
    setSettingOverrides({ ORCHESTRATOR_TOOL_LOOP: "true" });
    expect(toolLoopEnabled()).toBe(true);
    expect(loadPolicy().toolLoop).toBe(true);
    setSettingOverrides({ ORCHESTRATOR_TOOL_LOOP: "false" });
    process.env.ORCHESTRATOR_TOOL_LOOP = "1";
    expect(toolLoopEnabled()).toBe(false);
    expect(loadPolicy().toolLoop).toBe(false);
  });
});

describe("B2: one bool dialect for every bool var", () => {
  const bools = (ENV_SCHEMA as readonly EnvVar[]).filter((d) => d.type === "bool");

  it("every bool var uses it (no per-var dialect left)", () => {
    for (const def of bools) expect((def as { parse?: string }).parse ?? "bool", def.name).toBe("bool");
  });

  it("unset/blank → default; 1|true|yes|on → true; 0|false|no|off → false; anything else → default + a warning", () => {
    const issues: string[] = [];
    const previous = setEnvIssueSink((issue) => issues.push(issue.name));
    try {
      for (const def of bools) {
        const d = schemaDefault(def.name);
        const read = (raw: string | undefined) => readVar(def.name, raw === undefined ? {} : { [def.name]: raw });
        expect(read(undefined), def.name).toBe(d);
        expect(read(""), def.name).toBe(d);
        expect(read("  "), def.name).toBe(d);
        for (const raw of ["1", "true", "TRUE", " yes ", "on"]) expect(read(raw), `${def.name}=${raw}`).toBe(true);
        for (const raw of ["0", "false", "False", " no", "off"]) expect(read(raw), `${def.name}=${raw}`).toBe(false);
        issues.length = 0;
        expect(read("maybe"), def.name).toBe(d);
        expect(issues).toEqual([def.name]);
      }
    } finally {
      setEnvIssueSink(previous);
    }
  });

  it("the edge cases that changed (pre-B2 → now)", () => {
    // falsyList: "" was true, garbage was true.
    expect(readVar("ORCHESTRATOR_VERIFICATION_ENABLED", { ORCHESTRATOR_VERIFICATION_ENABLED: "maybe" })).toBe(true);
    expect(readVar("ORCHESTRATOR_WORKTREE_ISOLATION", { ORCHESTRATOR_WORKTREE_ISOLATION: "" })).toBe(false);
    expect(readVar("ORCHESTRATOR_WORKTREE_ISOLATION", { ORCHESTRATOR_WORKTREE_ISOLATION: "maybe" })).toBe(false);
    // neq0: "false" / "off" used to read as ON.
    expect(readVar("WORKER_SUBSCRIBE", { WORKER_SUBSCRIBE: "false" })).toBe(false);
    expect(readVar("FHARA_COMMIT_MESSAGE_LLM", { FHARA_COMMIT_MESSAGE_LLM: "off" })).toBe(false);
    // eq1: "true" used to read as OFF.
    expect(readVar("FHARA_ALLOW_LOCAL_MCP", { FHARA_ALLOW_LOCAL_MCP: "true" })).toBe(true);
    // The legacy alias chain is kept: QA_REQUIRED feeds ORCHESTRATOR_QA_REQUIRED's default.
    expect(readVar("ORCHESTRATOR_QA_REQUIRED", { QA_REQUIRED: "yes" })).toBe(true);
    expect(readVar("ORCHESTRATOR_QA_REQUIRED", { QA_REQUIRED: "yes", ORCHESTRATOR_QA_REQUIRED: "0" })).toBe(false);
  });
});

describe("B3: numbers are validated (no NaN), \"\" reads as the default", () => {
  const startup = [
    "WORKER_POLL_INTERVAL_MS",
    "WORKER_FALLBACK_POLL_MS",
    "WORKER_HEARTBEAT_MS",
    "WORKER_LEASE_MS",
    "WORKER_CONCURRENCY",
    "WORKER_STALE_GRACE_MS",
    "WORKER_PUSH_POLL_MS",
    "WORKER_MCP_TEST_POLL_MS",
    "WORKER_REPO_TOOL_POLL_MS",
    "WORKER_OPENCODE_CATALOG_POLL_MS",
    "DIRECT_POLL_MS",
    "ORCHESTRATOR_LLM_MAX_TOKENS",
    "ORCHESTRATOR_LLM_TIMEOUT_MS",
  ] as const;

  it("a typo (10s, abc, NaN) falls back to the default with one warning; blank is the default", () => {
    const issues: string[] = [];
    const previous = setEnvIssueSink((issue) => issues.push(`${issue.name}=${issue.raw}`));
    try {
      for (const name of startup) {
        const d = schemaDefault(name);
        for (const raw of ["10s", "abc", "NaN"]) {
          issues.length = 0;
          const value = readVar(name, { [name]: raw });
          expect(Number.isNaN(value), `${name}=${raw}`).toBe(false);
          expect(value, `${name}=${raw}`).toBe(d);
          expect(issues).toEqual([`${name}=${raw}`]);
        }
        expect(readVar(name, { [name]: "" })).toBe(d);
        expect(readVar(name, { [name]: "  " })).toBe(d);
      }
    } finally {
      setEnvIssueSink(previous);
    }
  });

  it("valid values are floored and kept at or above the minimum", () => {
    expect(readVar("WORKER_CONCURRENCY", { WORKER_CONCURRENCY: "0" })).toBe(1);
    expect(readVar("WORKER_CONCURRENCY", { WORKER_CONCURRENCY: "2.7" })).toBe(2);
    expect(readVar("WORKER_POLL_INTERVAL_MS", { WORKER_POLL_INTERVAL_MS: "0" })).toBe(100);
    expect(readVar("WORKER_HEARTBEAT_MS", { WORKER_HEARTBEAT_MS: "-5" })).toBe(1000);
    expect(readVar("WORKER_STALE_GRACE_MS", { WORKER_STALE_GRACE_MS: "0" })).toBe(0);
    expect(readVar("ORCHESTRATOR_LLM_TIMEOUT_MS", { ORCHESTRATOR_LLM_TIMEOUT_MS: "45000.9" })).toBe(45000);
    expect(readVar("ORCHESTRATOR_LLM_MAX_TOKENS", { ORCHESTRATOR_LLM_MAX_TOKENS: "1" })).toBe(256);
  });
});

describe("B5: one LLM fallback for the worker and Convex", () => {
  it("openai-compatible takes the OpenAI defaults in both, and both honour the flavour URL", async () => {
    const { getGlobalLLMConfig: worker } = await import("@/llm");
    const { getGlobalLLMConfig: convex } = await import("@/api/convex/lib/llmConfig");
    const cases: Array<Record<string, string>> = [
      { LLM_PROVIDER: "openai-compatible" },
      { LLM_PROVIDER: "openai-compatible", LLM_OPENAI_BASE_URL: "http://o/v1", LLM_BASE_URL: "http://b/v1" },
      { LLM_PROVIDER: "anthropic", LLM_ANTHROPIC_BASE_URL: "http://a/v1" },
      { LLM_PROVIDER: "OpenAI", LLM_MODEL: "m" },
      {},
    ];
    const saved = { ...process.env };
    try {
      for (const env of cases) {
        for (const k of ["LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_OPENAI_BASE_URL", "LLM_ANTHROPIC_BASE_URL", "LLM_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
        Object.assign(process.env, env);
        expect(convex()).toEqual(worker(env));
      }
      expect(worker({ LLM_PROVIDER: "openai-compatible" })).toMatchObject({ model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" });
      expect(worker({ LLM_PROVIDER: "openai-compatible", LLM_OPENAI_BASE_URL: "http://o/v1", LLM_BASE_URL: "http://b/v1" }).baseUrl).toBe("http://o/v1");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("B6: the worker decrypts with PROVIDER_ENCRYPTION_KEY_OLD during a rotation", () => {
  const keyB64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");
  async function seal(plaintext: string, b64: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", Buffer.from(b64, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
    const b = (u: Uint8Array) => Buffer.from(u).toString("base64");
    return ["v1", b(iv), b(sealed.slice(sealed.length - 16)), b(sealed.slice(0, sealed.length - 16))].join(":");
  }
  const saved = { cur: process.env.PROVIDER_ENCRYPTION_KEY, old: process.env.PROVIDER_ENCRYPTION_KEY_OLD };
  afterEach(async () => {
    const { resetEncryptionKeyCache } = await import("@/llm/crypto");
    for (const [k, v] of [["PROVIDER_ENCRYPTION_KEY", saved.cur], ["PROVIDER_ENCRYPTION_KEY_OLD", saved.old]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEncryptionKeyCache();
  });

  it("current key first, then the old key; a row neither opens stays a hard error", async () => {
    const { decryptApiKey, resetEncryptionKeyCache } = await import("@/llm/crypto");
    const fresh = await seal("new-row", keyB64(2));
    const stale = await seal("old-row", keyB64(1));
    const foreign = await seal("x", keyB64(9));

    process.env.PROVIDER_ENCRYPTION_KEY = keyB64(2);
    delete process.env.PROVIDER_ENCRYPTION_KEY_OLD;
    resetEncryptionKeyCache();
    expect(await decryptApiKey(fresh, "p")).toBe("new-row");
    await expect(decryptApiKey(stale, "p")).rejects.toThrow(/cannot be decrypted/);

    process.env.PROVIDER_ENCRYPTION_KEY_OLD = keyB64(1);
    resetEncryptionKeyCache();
    expect(await decryptApiKey(fresh, "p")).toBe("new-row");
    expect(await decryptApiKey(stale, "p")).toBe("old-row");
    await expect(decryptApiKey(foreign, "p")).rejects.toThrow(/Failed to decrypt API key for provider "p"/);
  });

  it("a malformed old key does not hide the current key's error", async () => {
    const { decryptApiKey, resetEncryptionKeyCache } = await import("@/llm/crypto");
    process.env.PROVIDER_ENCRYPTION_KEY = keyB64(2);
    process.env.PROVIDER_ENCRYPTION_KEY_OLD = "c2hvcnQ=";
    resetEncryptionKeyCache();
    await expect(decryptApiKey(await seal("x", keyB64(9)), "p")).rejects.toThrow(/cannot be decrypted/);
    expect(await decryptApiKey(await seal("ok", keyB64(2)), "p")).toBe("ok");
  });
});

describe("B7: one workspace-path resolver", () => {
  it("worker, web and Convex node resolve a project the same way from the same root and anchor", async () => {
    const nodePath = await import("node:path");
    const { resolveWorkspacePath } = await import("@/services/runner/setup");
    const { WORKER_DIR } = await import("@/utils/rootEnv");
    const { resolveWorkspaceBase } = await import("../../../../apps/web/lib/projectFilesPolicy");
    const { resolveRepoPath } = await import("@/api/convex/lib/workspacePath");
    for (const root of ["./workspaces", "ws", "/abs/ws"]) {
      for (const project of ["p1", "nested/p2", "/abs/proj"]) {
        const expected = nodePath.isAbsolute(project) ? nodePath.resolve(project) : nodePath.resolve(WORKER_DIR, root, project);
        expect(resolveWorkspacePath(root, project), `worker ${root} ${project}`).toBe(expected);
        expect(resolveWorkspaceBase(project, { WORKSPACE_ROOT: root }, WORKER_DIR), `web ${root} ${project}`).toBe(expected);
        expect(resolveRepoPath(project, { env: { WORKSPACE_ROOT: root }, cwd: WORKER_DIR }), `convex ${root} ${project}`).toBe(expected);
      }
    }
  });

  it("the worker's root no longer depends on its cwd", async () => {
    const nodePath = await import("node:path");
    const { effectiveWorkspaceRoot } = await import("@/services/appSettings");
    const { WORKER_DIR } = await import("@/utils/rootEnv");
    const cwd = process.cwd();
    const saved = process.env.WORKSPACE_ROOT;
    try {
      process.env.WORKSPACE_ROOT = "./workspaces";
      process.chdir(nodePath.resolve(WORKER_DIR, "../.."));
      expect(effectiveWorkspaceRoot()).toBe(nodePath.resolve(WORKER_DIR, "workspaces"));
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = saved;
    }
  });
});

describe("startup: .env is loaded before any module-load read; the log shows the CONVEX_URL alias", () => {
  it("index.ts imports utils/loadEnv first and nothing else calls dotenv", async () => {
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const src = nodePath.resolve(import.meta.dirname, "../../src");
    const index = fs.readFileSync(nodePath.join(src, "index.ts"), "utf8");
    const firstImport = index.split("\n").find((l) => l.startsWith("import "));
    expect(firstImport).toBe('import "./utils/loadEnv";');
    const loadEnv = fs.readFileSync(nodePath.join(src, "utils/loadEnv.ts"), "utf8");
    expect(loadEnv).toContain("dotenv.config({ path: ROOT_ENV_FILE })");
    const others: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ts$/.test(e.name) && !full.endsWith("utils/loadEnv.ts") && /dotenv\.config\(/.test(fs.readFileSync(full, "utf8"))) others.push(full);
      }
    };
    walk(src);
    expect(others).toEqual([]);
  });

  it("the listening line reads NEXT_PUBLIC_CONVEX_URL with its CONVEX_URL alias", async () => {
    const { wenv } = await import("@fhara/config/worker");
    expect(wenv("NEXT_PUBLIC_CONVEX_URL", { CONVEX_URL: "http://legacy" })).toBe("http://legacy");
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const index = fs.readFileSync(nodePath.resolve(import.meta.dirname, "../../src/index.ts"), "utf8");
    expect(index).toContain('listening: convex=${wenv("NEXT_PUBLIC_CONVEX_URL")}');
  });
});

describe("QA_CHROMIUM_NO_SANDBOX: the Settings knob shows the real default (auto)", () => {
  it("is an auto / true / false knob defaulting to auto, and auto reads as auto", async () => {
    const { SETTING_KNOBS, normalizeSettingValue } = await import("@/api/convex/lib/appSettings");
    expect(SETTING_KNOBS.QA_CHROMIUM_NO_SANDBOX).toEqual({ type: "enum", defaultValue: "auto", reader: "worker", options: ["auto", "true", "false"] });
    expect(normalizeSettingValue("QA_CHROMIUM_NO_SANDBOX", "Auto")).toBe("auto");
    expect(readVar("QA_CHROMIUM_NO_SANDBOX", { QA_CHROMIUM_NO_SANDBOX: "auto" })).toBeUndefined();
    expect(readVar("QA_CHROMIUM_NO_SANDBOX", {})).toBeUndefined();
    expect(readVar("QA_CHROMIUM_NO_SANDBOX", { QA_CHROMIUM_NO_SANDBOX: "true" })).toBe(true);
    expect(readVar("QA_CHROMIUM_NO_SANDBOX", { QA_CHROMIUM_NO_SANDBOX: "off" })).toBe(false);
    const previous = setEnvIssueSink(() => {});
    try {
      expect(readVar("QA_CHROMIUM_NO_SANDBOX", { QA_CHROMIUM_NO_SANDBOX: "maybe" })).toBeUndefined();
    } finally {
      setEnvIssueSink(previous);
    }
  });
});
