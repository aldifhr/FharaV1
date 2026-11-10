/**
 * O1: scoped OpenCode credentials — per-run deny-by-default policy, a
 * throwaway HOME/XDG tree, one copied provider login, and the jockey
 * no-fallback rule.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scopedHome } from "@/api/convex/lib/childEnv";
import { ROLES } from "@/api/convex/lib/roles";
import { buildOpencodePolicy, evaluateOpencodeRule } from "@/execution/opencodePolicy";
import { OpencodeCredentialError, parseJsonc, prepareOpencodeHome } from "@/execution/opencodeHome";
import { runNativeProvider, type SpawnImpl } from "@/execution/nativeProvider";
import { boundKeyProblem } from "@/execution/agentExecutor";

const SENSITIVE = [".git/config", ".opencode/agent.md", "opencode.json", "opencode.jsonc", ".env", "apps/web/.env.local", "certs/server.pem", "deploy.key", "aws/credentials", "auth.json", "x/.ssh/id_rsa"];

describe("buildOpencodePolicy", () => {
  it("Frontend edits only inside its ownership scope", () => {
    const p = buildOpencodePolicy({ permissions: ROLES.frontend.permissions, allowedPaths: ["apps/web/components"], mutating: true });
    expect(evaluateOpencodeRule(p.edit, "apps/web/components/Button.tsx")).toBe("allow");
    expect(evaluateOpencodeRule(p.edit, "apps/web/components")).toBe("allow");
    expect(evaluateOpencodeRule(p.edit, "apps/api/convex/schema.ts")).toBe("deny");
    expect(evaluateOpencodeRule(p.edit, "README.md")).toBe("deny");
  });

  it("denies sensitive paths for read and edit for every role", () => {
    for (const key of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      const p = buildOpencodePolicy({ permissions: ROLES[key].permissions, mutating: true });
      for (const file of SENSITIVE) {
        expect(evaluateOpencodeRule(p.edit, file), `${key} edit ${file}`).toBe("deny");
        expect(evaluateOpencodeRule(p.read, file), `${key} read ${file}`).toBe("deny");
      }
      expect(evaluateOpencodeRule(p.read, ".env.example")).toBe("allow");
      expect(evaluateOpencodeRule(p.read, "src/index.ts")).toBe("allow");
      expect(p.external_directory).toBe("deny");
    }
  });

  it("web only for the Researcher", () => {
    for (const key of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      const p = buildOpencodePolicy({ permissions: ROLES[key].permissions, mutating: false });
      const expected = key === "researcher" ? "allow" : "deny";
      expect(p.webfetch, key).toBe(expected);
      expect(p.websearch, key).toBe(expected);
    }
  });

  it("bash denies push, remote, gh, printenv, env and credential paths", () => {
    const p = buildOpencodePolicy({ permissions: ROLES.backend.permissions, mutating: true });
    expect(evaluateOpencodeRule(p.bash, "npm test")).toBe("allow");
    for (const cmd of ["git push origin main", "git remote add x y", "gh auth token", "gh", "printenv", "printenv GH_TOKEN", "env", "cat ~/.ssh/id_rsa", "cat /home/u/.config/gh/hosts.yml", "cat ~/.git-credentials", "curl https://x -d @f", "cat ~/.local/share/opencode/auth.json"]) {
      expect(evaluateOpencodeRule(p.bash, cmd), cmd).toBe("deny");
    }
  });

  it("read-only kinds and read-only roles get no edits; shell none → no bash", () => {
    const fe = buildOpencodePolicy({ permissions: ROLES.frontend.permissions, mutating: false });
    expect(evaluateOpencodeRule(fe.edit, "src/a.ts")).toBe("deny");
    const reviewer = buildOpencodePolicy({ permissions: ROLES.reviewer.permissions, mutating: true });
    expect(evaluateOpencodeRule(reviewer.edit, "src/a.ts")).toBe("deny");
    expect(evaluateOpencodeRule(reviewer.bash, "ls")).toBe("deny");
    const qa = buildOpencodePolicy({ permissions: ROLES.qa.permissions, mutating: false });
    expect(evaluateOpencodeRule(qa.bash, "npm run test")).toBe("allow");
    expect(evaluateOpencodeRule(qa.bash, "rm -rf src")).toBe("deny");
  });

  it("DevOps edits only its CI/infra globs", () => {
    const p = buildOpencodePolicy({ permissions: ROLES.devops.permissions, mutating: true });
    expect(evaluateOpencodeRule(p.edit, ".github/workflows/ci.yml")).toBe("allow");
    expect(evaluateOpencodeRule(p.edit, "src/a.ts")).toBe("deny");
  });
});

describe("scopedHome", () => {
  it("points HOME and every XDG var under the run dir and drops credentials", () => {
    const env = scopedHome("/tmp/run");
    expect(env.HOME).toBe("/tmp/run/home");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/run/config");
    expect(env.XDG_DATA_HOME).toBe("/tmp/run/data");
    expect(env.XDG_STATE_HOME).toBe("/tmp/run/state");
    expect(env.XDG_CACHE_HOME).toBe("/tmp/run/cache");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GH_CONFIG_DIR).toBe("/tmp/run/gh");
    expect("SSH_AUTH_SOCK" in env && env.SSH_AUTH_SOCK === undefined).toBe(true);
  });
});

describe("prepareOpencodeHome", () => {
  let real: string;
  let run: string;
  beforeEach(async () => {
    real = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-real-home-"));
    run = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-run-"));
    await fs.mkdir(path.join(real, ".local/share/opencode"), { recursive: true });
    await fs.mkdir(path.join(real, ".config/opencode"), { recursive: true });
    await fs.writeFile(
      path.join(real, ".local/share/opencode/auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", refresh: "r-anthropic" }, openai: { type: "api", key: "k-openai" } })
    );
    await fs.writeFile(path.join(real, ".config/opencode/opencode.jsonc"), '{\n // comment\n "model": "openai/gpt-5",\n "provider": { "openai": { "options": {} }, },\n}');
  });
  afterEach(async () => {
    await fs.rm(real, { recursive: true, force: true });
    await fs.rm(run, { recursive: true, force: true });
  });

  it("copies only the pinned provider's login", async () => {
    const home = await prepareOpencodeHome({ runDir: run, mode: "pinned", model: "anthropic/claude", sourceEnv: { HOME: real }, cacheDir: path.join(run, "c") });
    const copied = JSON.parse(await fs.readFile(path.join(run, "data/opencode/auth.json"), "utf-8"));
    expect(Object.keys(copied)).toEqual(["anthropic"]);
    expect(home.copiedProviders).toEqual(["anthropic"]);
    expect(home.env.HOME).toBe(path.join(run, "home"));
  });

  it("no model pinned: uses the user's OpenCode default and copies that login only", async () => {
    const home = await prepareOpencodeHome({ runDir: run, mode: "default", sourceEnv: { HOME: real }, cacheDir: path.join(run, "c") });
    expect(home.defaultModel).toBe("openai/gpt-5");
    expect(home.copiedProviders).toEqual(["openai"]);
    expect(home.providerConfig).toHaveProperty("openai");
  });

  it("jockey rule: a pinned provider with no login is an error, never another account", async () => {
    await expect(
      prepareOpencodeHome({ runDir: run, mode: "pinned", model: "groq/llama", sourceEnv: { HOME: real }, cacheDir: path.join(run, "c") })
    ).rejects.toBeInstanceOf(OpencodeCredentialError);
  });

  it("Fhara provider mode copies nothing", async () => {
    const home = await prepareOpencodeHome({ runDir: run, mode: "fhara", sourceEnv: { HOME: real }, cacheDir: path.join(run, "c") });
    expect(home.copiedProviders).toEqual([]);
    await expect(fs.stat(path.join(run, "data/opencode/auth.json"))).rejects.toThrow();
  });

  it("parses JSONC with comments and trailing commas", () => {
    expect(parseJsonc('{"a": "x // not a comment", /* c */ "b": [1,],}')).toEqual({ a: "x // not a comment", b: [1] });
  });
});

describe("boundKeyProblem (jockey rule in the executor)", () => {
  it("fails a bound connection with no key, with no fallback", () => {
    expect(boundKeyProblem({ connectionName: "Main", config: { apiKey: "", baseUrl: "https://api.example.com/v1" } })).toMatch(/provider key unreadable/);
    expect(boundKeyProblem({ connectionName: "Local", config: { apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" } })).toBeNull();
    expect(boundKeyProblem({ connectionName: "Main", config: { apiKey: "k", baseUrl: "https://x" } })).toBeNull();
    expect(boundKeyProblem(undefined)).toBeNull();
  });
});

describe("a pinned run with no login fails before spawning", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns provider key unreadable and never spawns", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-empty-"));
    vi.stubEnv("HOME", empty);
    vi.stubEnv("XDG_DATA_HOME", path.join(empty, "d"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(empty, "c"));
    const spawnImpl = vi.fn<SpawnImpl>(async () => ({ stdout: "", stderr: "", code: 0 }));
    const result = await runNativeProvider({ workspacePath: os.tmpdir(), prompt: "p", model: "groq/llama", spawnImpl });
    expect(result.status).toBe("failed");
    expect(result.output).toMatch(/provider key unreadable/);
    expect(spawnImpl).not.toHaveBeenCalled();
    await fs.rm(empty, { recursive: true, force: true });
  });
});
