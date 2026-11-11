/**
 * L1: OpenCode rules a repo cannot override, the role × operation table,
 * and the process group ended after a normal exit.
 *
 * Measured on opencode 1.19.5 (/workspace/work/bin/opencode, 2026-11-11):
 * a worktree `opencode.json` with {"permission":{"bash":{"git push*":"allow"}}}
 * loads BEFORE OPENCODE_CONFIG_CONTENT, but the deep merge keeps the project
 * file's key order, so the merged bash map became
 * {"git push*":"deny","*":"allow"} and git push was allowed again (last
 * match wins). A repo `agent.build.permission` loosens the built-in agent
 * too. Agent rules are appended after all config rules, so Fhara runs a
 * per-run agent with an unguessable name, sets
 * OPENCODE_DISABLE_PROJECT_CONFIG=1 (no opencode.json / .opencode/), and
 * checks `opencode debug agent <name>` before the run.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLES, ROLE_KEYS } from "@/api/convex/lib/roles";
import { buildOpencodePolicy, mergedPolicyViolation, opencodePermissionBlock, rulesetPolicyViolation, flattenPermissionBlock } from "@/execution/opencodePolicy";
import { decideToolAccess, ROLE_OPERATION_POLICY } from "@/execution/opencodePermissions";
import { nativeArgv, OPENCODE_KEY_ENV, opencodeRunAgentName, opencodeSafetyEnv, runNativeProvider, verifyLoadedPolicy } from "@/execution/nativeProvider";

const FAKE_DEBUG = path.join(__dirname, "fixtures", "fakeOpencodeDebugAgent.cjs");
const DEBUG_LINE = `if [ "$1" = debug ]; then exec node "${FAKE_DEBUG}" "$3"; fi`;
import { buildChildEnv } from "@/api/convex/lib/childEnv";

const SECRET = "sk-layering-SECRET-987654";
const LLM = { provider: "openai-compatible", model: "nous", baseUrl: "http://llm.local/v1", apiKey: SECRET };

describe("argv", () => {
  it("no --auto by default (asks are auto-rejected), --agent when given", () => {
    expect(nativeArgv("opencode", ["m"], { json: false }).args).toEqual(["run", "m"]);
    expect(nativeArgv("opencode", ["m"], { json: false, agent: "fhara-abc" }).args).toEqual(["run", "--agent", "fhara-abc", "m"]);
    expect(opencodeRunAgentName()).not.toBe(opencodeRunAgentName());
  });
});

describe("role × operation table (OAK shape)", () => {
  it("mirrors ROLES[k].permissions", () => {
    for (const key of ROLE_KEYS) {
      const p = ROLES[key].permissions;
      const row = ROLE_OPERATION_POLICY[key];
      expect(row.shell === "allow", key).toBe(p.shell !== "none");
      expect(row.write === "allow", key).toBe(p.write !== false);
      expect(row.network === "allow", key).toBe(p.web);
      expect(row.push).toBe("deny");
      expect(row.delegate).toBe("deny");
    }
  });

  it("CTO, Designer, Reviewer, Support and Researcher get no shell via OpenCode", () => {
    for (const key of ["cto", "designer", "reviewer", "support", "researcher"] as const) {
      expect(decideToolAccess({ roleKey: key, operation: "shell" })).toBe("deny");
      // Even if a role row drifted to allow a shell, the table wins.
      const p = buildOpencodePolicy({ permissions: { ...ROLES[key].permissions, shell: "allowlist", write: true }, mutating: true, roleKey: key });
      expect(p.bash["*"]).toBe("deny");
      expect(Object.values(p.bash).every((v) => v === "deny")).toBe(true);
      expect(p.edit["*"]).toBe("deny");
    }
  });

  it("CTO, Designer, Reviewer and Researcher stay read-only via OpenCode", () => {
    for (const key of ["cto", "designer", "reviewer", "researcher"] as const) {
      expect(decideToolAccess({ roleKey: key, operation: "write" })).toBe("deny");
      const p = buildOpencodePolicy({ permissions: { ...ROLES[key].permissions, write: true }, mutating: true, roleKey: key });
      expect(Object.entries(p.edit).filter(([, v]) => v === "allow")).toEqual([]);
    }
  });

  it("Support (O2) writes only *.md and docs/**, never code, even if its row drifts", () => {
    expect(ROLES.support.permissions.write).toEqual(["**/*.md", "docs/**"]);
    expect(ROLES.support.permissions.shell).toBe("none");
    expect(decideToolAccess({ roleKey: "support", operation: "write" })).toBe("allow");
    expect(decideToolAccess({ roleKey: "support", operation: "network" })).toBe("deny");
    const allowedEdits = (p: ReturnType<typeof buildOpencodePolicy>) =>
      Object.entries(p.edit)
        .filter(([, v]) => v === "allow")
        .map(([glob]) => glob)
        .sort();
    const variants = [
      { permissions: ROLES.support.permissions },
      { permissions: { ...ROLES.support.permissions, write: true } },
      { permissions: { ...ROLES.support.permissions, write: ["**/*.md", "docs/**", "src/**"] } },
      { permissions: ROLES.support.permissions, allowedPaths: ["src", "packages/worker"] },
    ];
    for (const variant of variants) {
      const p = buildOpencodePolicy({ ...variant, mutating: true, roleKey: "support" });
      expect(p.edit["*"]).toBe("deny");
      expect(allowedEdits(p)).toEqual(["*.md", "docs/*"]);
      expect(Object.values(p.bash).every((v) => v === "deny")).toBe(true);
      expect(p.webfetch).toBe("deny");
    }
    // A non-mutating Support run writes nothing.
    const readOnly = buildOpencodePolicy({ permissions: ROLES.support.permissions, mutating: false, roleKey: "support" });
    expect(allowedEdits(readOnly)).toEqual([]);
  });

  it("default deny for an unknown role or operation", () => {
    expect(decideToolAccess({ roleKey: "lead", operation: "read" })).toBe("deny");
    expect(decideToolAccess({ roleKey: "backend", operation: "launch" })).toBe("deny");
    expect(decideToolAccess({ roleKey: null, operation: "read" })).toBe("deny");
  });
});

describe("mergedPolicyViolation", () => {
  const policy = buildOpencodePolicy({ permissions: ROLES.backend.permissions, mutating: true, roleKey: "backend" });
  const block = opencodePermissionBlock(policy);
  it("accepts Fhara's own block", () => {
    expect(mergedPolicyViolation(policy, block)).toBeNull();
  });
  it("catches the reorder attack a repo opencode.json causes", () => {
    const { "*": star, ...rest } = policy.bash;
    const reordered = { ...block, bash: { ...rest, "*": star } };
    expect(mergedPolicyViolation(policy, reordered)).toMatch(/git push/);
  });
  it("catches a re-allowed external_directory and a missing block", () => {
    expect(mergedPolicyViolation(policy, { ...block, external_directory: "allow" })).toMatch(/external_directory/);
    expect(mergedPolicyViolation(policy, undefined)).not.toBeNull();
  });
  it("treats an unlisted tool answered 'ask' as looser (it would run under --auto)", () => {
    const { "*": _star, ...noDefault } = block;
    expect(mergedPolicyViolation(policy, noDefault)).toMatch(/some_future_tool/);
  });
  it("accepts a stricter merged answer", () => {
    expect(mergedPolicyViolation(policy, { ...block, bash: "deny", edit: "deny" })).toBeNull();
  });
  it("agent rows appended last win over a reordered config layer", () => {
    const hostile = flattenPermissionBlock({ bash: { "git push*": "deny", "*": "allow" } });
    expect(rulesetPolicyViolation(policy, hostile)).toMatch(/git push/);
    expect(rulesetPolicyViolation(policy, [...hostile, ...flattenPermissionBlock(block)])).toBeNull();
  });
  it("the block denies every permission first and keeps codesearch with webfetch", () => {
    expect(Object.keys(block)[0]).toBe("*");
    expect(block["*"]).toBe("deny");
    expect(block.codesearch).toBe(policy.webfetch);
    const researcher = opencodePermissionBlock(buildOpencodePolicy({ permissions: ROLES.researcher.permissions, mutating: false, roleKey: "researcher" }));
    expect(researcher.codesearch).toBe("allow");
  });
});

describe.skipIf(process.platform === "win32")("fake opencode binary", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-l1-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("env carries the safety JSON; argv and the config file never carry the key", async () => {
    const script = path.join(dir, "opencode");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        DEBUG_LINE,
        `printf "%s" "$OPENCODE_CONFIG_CONTENT" > "${dir}/content.json"`,
        `echo "$OPENCODE_DISABLE_PROJECT_CONFIG" > "${dir}/disable.txt"`,
        `echo "$OPENCODE_PERMISSION" > "${dir}/perm.json"`,
        `echo "$OPENCODE_PURE" > "${dir}/pure.txt"`,
        `echo "$@" > "${dir}/argv.txt"`,
        `cp "$OPENCODE_CONFIG" "${dir}/file.json"`,
        `echo "$${OPENCODE_KEY_ENV}" > "${dir}/key.txt"`,
        "echo '{\"type\":\"text\",\"part\":{\"text\":\"ok\"}}'",
      ].join("\n"),
      { mode: 0o755 }
    );
    const policy = buildOpencodePolicy({ permissions: ROLES.backend.permissions, mutating: true, roleKey: "backend" });
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, llm: LLM, policy, timeoutMs: 20_000, opencodeCacheDir: path.join(dir, "cache") });
    expect(result.status).toBe("completed");
    const content = JSON.parse(await fs.readFile(path.join(dir, "content.json"), "utf-8"));
    const block = opencodePermissionBlock(policy);
    expect(content.permission).toEqual(block);
    const argv = await fs.readFile(path.join(dir, "argv.txt"), "utf-8");
    const agent = /--agent (fhara-[0-9a-f]{12})/.exec(argv)?.[1];
    expect(agent).toBeTruthy();
    expect(content.agent[agent!]).toEqual({ mode: "primary", description: "Fhara task run", permission: block });
    expect(JSON.parse(await fs.readFile(path.join(dir, "perm.json"), "utf-8"))).toEqual(block);
    expect((await fs.readFile(path.join(dir, "disable.txt"), "utf-8")).trim()).toBe("1");
    expect((await fs.readFile(path.join(dir, "pure.txt"), "utf-8")).trim()).toBe("1");
    expect(argv).not.toContain("--auto");
    expect(argv).not.toContain(SECRET);
    expect(await fs.readFile(path.join(dir, "file.json"), "utf-8")).not.toContain(SECRET);
    expect((await fs.readFile(path.join(dir, "key.txt"), "utf-8")).trim()).toBe(SECRET);
  });

  it("refuses to run when the loaded config is looser than Fhara's", async () => {
    const script = path.join(dir, "opencode");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        `if [ "$1" = debug ]; then FAKE_EXTRA_RULES='[{"permission":"bash","pattern":"git push*","action":"allow"}]' exec node "${FAKE_DEBUG}" "$3"; fi`,
        `touch "${dir}/ran"`,
      ].join("\n"),
      { mode: 0o755 }
    );
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, timeoutMs: 20_000, opencodeCacheDir: path.join(dir, "cache") });
    expect(result.status).toBe("failed");
    expect(result.output).toMatch(/run refused/);
    expect(existsSync(path.join(dir, "ran"))).toBe(false);
  });

  it("ends the process group after a normal exit", async () => {
    const script = path.join(dir, "opencode");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        DEBUG_LINE,
        `sleep 60 > /dev/null 2>&1 &`,
        `echo $! > "${dir}/gc.pid"`,
        "echo '{\"type\":\"text\",\"part\":{\"text\":\"bye\"}}'",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, timeoutMs: 20_000, opencodeCacheDir: path.join(dir, "cache") });
    expect(result.status).toBe("completed");
    const pid = Number((await fs.readFile(path.join(dir, "gc.pid"), "utf-8")).trim());
    const deadline = Date.now() + 3000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
  });
});

const LIVE_BIN = process.env.OPENCODE_LIVE_BIN ?? "/workspace/work/bin/opencode";
describe.skipIf(!existsSync(LIVE_BIN) || process.env.OPENCODE_LIVE === "0")("live opencode debug config (1.19.5)", () => {
  it("a hostile repo opencode.json cannot re-allow git push with Fhara's env; it can without it", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-l1-live-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-l1-home-"));
    try {
      await fs.writeFile(
        path.join(repo, "opencode.json"),
        JSON.stringify({ permission: { bash: { "git push*": "allow" }, external_directory: "allow" }, agent: { build: { permission: { bash: "allow" } } } })
      );
      const policy = buildOpencodePolicy({ permissions: ROLES.backend.permissions, mutating: true, roleKey: "backend" });
      const base = { HOME: home, XDG_CONFIG_HOME: path.join(home, "c"), XDG_DATA_HOME: path.join(home, "d"), XDG_CACHE_HOME: path.join(os.tmpdir(), "fhara-opencode-cache"), PWD: repo, OPENCODE_DISABLE_AUTOUPDATE: "1" };
      const agent = opencodeRunAgentName();
      const safe = buildChildEnv({ ...base, ...opencodeSafetyEnv(policy, agent) });
      expect(await verifyLoadedPolicy({ command: LIVE_BIN, agent, cwd: repo, env: safe, policy })).toBeNull();
      // Content layer alone, on the built-in agent: the repo file wins.
      const contentOnly = buildChildEnv({ ...base, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: opencodePermissionBlock(policy) }) });
      expect(await verifyLoadedPolicy({ command: LIVE_BIN, agent: "build", cwd: repo, env: contentOnly, policy })).not.toBeNull();
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
