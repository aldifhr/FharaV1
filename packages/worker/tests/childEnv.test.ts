import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildChildEnv,
  CHILD_ENV_PASSTHROUGH_VAR,
  DEFAULT_DENIED_SECRET_ENV_KEYS,
  WORKER_SECRET_ENV_KEYS,
} from "@/api/convex/lib/childEnv";
import { runNativeProvider, type SpawnOptions, type SpawnImpl } from "@/execution/nativeProvider";
import { runCommand } from "@/tools/runCommand";
import { runVerification } from "@/execution/verification";
import { buildMcpChildEnv } from "@/mcp/client";
import { githubAuthEnv } from "@/tools/gitPush";

/**
 * Denylist: none of these may ever appear in a child process env built
 * from the worker's own environment.
 */
const SECRET_NAMES = [
  ...WORKER_SECRET_ENV_KEYS,
  ...DEFAULT_DENIED_SECRET_ENV_KEYS,
  // Non-standard names an operator might keep in the worker env.
  "SOME_APP_SECRET",
  "DATABASE_URL",
];
const MUST_INCLUDE = [
  "CONVEX_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

const secretValue = (name: string) => `leak-${name.toLowerCase()}-value`;

function poisonedEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/fhara",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/tmp",
    NODE_ENV: "production",
    CI: "1",
    HTTPS_PROXY: "http://proxy:3128",
    HTTP_PROXY: "http://proxy:3128",
    NO_PROXY: "localhost",
    NODE_USE_ENV_PROXY: "1",
  };
  for (const name of SECRET_NAMES) env[name] = secretValue(name);
  return env;
}

function expectNoSecrets(env: Record<string, string | undefined>) {
  for (const name of SECRET_NAMES) {
    expect(env[name], `${name} leaked into child env`).toBeUndefined();
  }
  const values = Object.values(env).join("\n");
  for (const name of SECRET_NAMES) expect(values).not.toContain(secretValue(name));
}

// process.env poisoning for the end-to-end spawn checks.
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const name of [...SECRET_NAMES, CHILD_ENV_PASSTHROUGH_VAR]) {
    saved[name] = process.env[name];
    if (name !== CHILD_ENV_PASSTHROUGH_VAR) process.env[name] = secretValue(name);
    else delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("buildChildEnv denylist", () => {
  it("covers the secrets named in the security review", () => {
    for (const name of MUST_INCLUDE) expect(SECRET_NAMES).toContain(name);
  });

  it("never forwards a secret name from the parent env", () => {
    const env = buildChildEnv(undefined, { source: poisonedEnv() });
    expectNoSecrets(env);
  });

  it("forwards the allowlist (PATH, HOME, locale, TERM, TMPDIR, NODE_ENV, CI, proxies)", () => {
    const env = buildChildEnv(undefined, { source: poisonedEnv() });
    for (const key of [
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
      "TMPDIR",
      "NODE_ENV",
      "CI",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "NODE_USE_ENV_PROXY",
    ]) {
      expect(env[key], key).toBeDefined();
    }
  });

  it("defaults to process.env and still scrubs it", () => {
    expectNoSecrets(buildChildEnv());
    expect(buildChildEnv().PATH).toBe(process.env.PATH);
  });

  it("adds explicit per-run vars, but never worker secrets", () => {
    const env = buildChildEnv(
      { MOAGENT_OPENCODE_API_KEY: "agent-key", CONVEX_SERVICE_TOKEN: "smuggled", PROVIDER_ENCRYPTION_KEY: "x" },
      { source: poisonedEnv() }
    );
    expect(env.MOAGENT_OPENCODE_API_KEY).toBe("agent-key");
    expect(env.CONVEX_SERVICE_TOKEN).toBeUndefined();
    expect(env.PROVIDER_ENCRYPTION_KEY).toBeUndefined();
  });

  it("lets an undefined extra remove an inherited var", () => {
    const env = buildChildEnv({ HTTPS_PROXY: undefined }, { source: poisonedEnv() });
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it(`honours ${CHILD_ENV_PASSTHROUGH_VAR} but never for worker secrets`, () => {
    const source = {
      ...poisonedEnv(),
      MY_TOOL_HOME: "/opt/tool",
      [CHILD_ENV_PASSTHROUGH_VAR]:
        " MY_TOOL_HOME, OPENAI_API_KEY ,CONVEX_SERVICE_TOKEN,PROVIDER_ENCRYPTION_KEY,CONVEX_SELF_HOSTED_ADMIN_KEY,,bad name",
    };
    const env = buildChildEnv(undefined, { source });
    expect(env.MY_TOOL_HOME).toBe("/opt/tool");
    // Operator explicitly opted in to this provider key.
    expect(env.OPENAI_API_KEY).toBe(secretValue("OPENAI_API_KEY"));
    for (const name of WORKER_SECRET_ENV_KEYS) expect(env[name], name).toBeUndefined();
    expect(env[CHILD_ENV_PASSTHROUGH_VAR]).toBeUndefined();
  });
});

describe("spawn sites use the scrubbed env", () => {
  it("native provider (OpenCode) gets only the allowlist plus its own key", async () => {
    let captured: SpawnOptions | undefined;
    const spawnImpl: SpawnImpl = async (_command, _args, options) => {
      captured = options;
      return { stdout: "", stderr: "", code: 0 };
    };
    await runNativeProvider({
      workspacePath: os.tmpdir(),
      prompt: "do it",
      spawnImpl,
      llm: { provider: "openai", apiKey: "per-run-agent-key", model: "gpt-x", baseUrl: "https://llm.example/v1" },
    });
    expect(captured?.env).toBeDefined();
    const env = captured!.env as Record<string, string | undefined>;
    expectNoSecrets(env);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.PWD).toBe(os.tmpdir());
    expect(env.OPENCODE_CONFIG).toBeDefined();
  });

  it("MCP stdio env keeps the server's own token, drops the worker's", () => {
    const env = buildMcpChildEnv(undefined, { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_server" });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_server");
    for (const name of WORKER_SECRET_ENV_KEYS) expect(env[name], name).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("git push env carries the push header but no worker secrets", () => {
    const env = githubAuthEnv("ghp_pushtoken");
    for (const name of WORKER_SECRET_ENV_KEYS) expect(env[name], name).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
  });

  describe("real child processes", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-childenv-"));
      await fs.writeFile(
        path.join(dir, "dump.js"),
        `require("fs").writeFileSync(${JSON.stringify(path.join("__DIR__", "env.json"))}.replace("__DIR__", __dirname), JSON.stringify(process.env));\n`,
        "utf-8"
      );
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "envdump", scripts: { test: "node dump.js" } }),
        "utf-8"
      );
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
    const readDump = async () =>
      JSON.parse(await fs.readFile(path.join(dir, "env.json"), "utf-8")) as Record<string, string>;

    it("run_command (npm run test) sees no worker secrets", async () => {
      await runCommand(dir, "npm", ["run", "test"]);
      const env = await readDump();
      expectNoSecrets(env);
      expect(env.PATH).toBeDefined();
    }, 60_000);

    it("verification commands see no worker secrets", async () => {
      await runVerification({ workspacePath: dir, timeoutMs: 30_000 });
      const env = await readDump();
      expectNoSecrets(env);
      expect(env.CI).toBe("1");
    }, 60_000);
  });
});

describe("static guard", () => {
  const SRC = path.resolve(__dirname, "../src");

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("no worker source spreads process.env into anything", { timeout: 30_000 }, async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      const text = await fs.readFile(file, "utf-8");
      if (/\.\.\.\s*process\.env\b/.test(text)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it("every worker file that spawns processes builds its env with buildChildEnv", { timeout: 30_000 }, async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      const text = await fs.readFile(file, "utf-8");
      if (!/from\s+["']node:child_process["']/.test(text)) continue;
      if (!/buildChildEnv|buildMcpChildEnv/.test(text)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
