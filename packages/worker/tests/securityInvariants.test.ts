/**
 * Security invariants for agent runs (O1). These run a REAL child process
 * through runNativeProvider (a fake `opencode` shell script), so they test
 * the env the agent's shell actually gets, not a mock of it.
 *
 * Invariant: during an OpenCode run, the agent's shell cannot read the
 * user's real ~/.ssh, gh hosts file, ~/.git-credentials or OpenCode auth
 * store through `~`/$HOME/XDG paths, and the SSH agent socket and GitHub
 * tokens never reach it.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNativeProvider } from "@/execution/nativeProvider";

const PLANTED = {
  ssh: "PLANTED-SSH-PRIVATE-KEY",
  gh: "PLANTED-GH-OAUTH-TOKEN",
  gitCreds: "PLANTED-GIT-CREDENTIAL",
  auth: "PLANTED-OPENAI-KEY-NOT-NEEDED",
};

describe.skipIf(process.platform === "win32")("securityInvariants: OpenCode run sees a scoped home", () => {
  let realHome: string;
  let ws: string;
  let bin: string;
  beforeEach(async () => {
    realHome = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-inv-home-"));
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-inv-ws-"));
    bin = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-inv-bin-"));
    await fs.mkdir(path.join(realHome, ".ssh"), { recursive: true });
    await fs.mkdir(path.join(realHome, ".config/gh"), { recursive: true });
    await fs.mkdir(path.join(realHome, ".local/share/opencode"), { recursive: true });
    await fs.writeFile(path.join(realHome, ".ssh/id_rsa"), PLANTED.ssh);
    await fs.writeFile(path.join(realHome, ".config/gh/hosts.yml"), `github.com:\n  oauth_token: ${PLANTED.gh}\n`);
    await fs.writeFile(path.join(realHome, ".git-credentials"), `https://u:${PLANTED.gitCreds}@github.com\n`);
    await fs.writeFile(
      path.join(realHome, ".local/share/opencode/auth.json"),
      JSON.stringify({ anthropic: { type: "api", key: "the-one-needed" }, openai: { type: "api", key: PLANTED.auth } })
    );
    vi.stubEnv("HOME", realHome);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(realHome, ".config"));
    vi.stubEnv("XDG_DATA_HOME", path.join(realHome, ".local/share"));
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/planted-agent.sock");
    vi.stubEnv("GH_TOKEN", PLANTED.gh);
    vi.stubEnv("FHARA_CHILD_ENV_PASSTHROUGH", "SSH_AUTH_SOCK,GH_TOKEN");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of [realHome, ws, bin]) await fs.rm(dir, { recursive: true, force: true });
  });

  it("an agent shell cannot read the real ~/.ssh, gh hosts, git credentials or other OpenCode logins", async () => {
    // A fake `opencode` that does what a prompt-injected agent would.
    const script = path.join(bin, "opencode");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        'OUT=$( { cat ~/.ssh/id_rsa; cat "$HOME/.config/gh/hosts.yml"; cat ~/.git-credentials;',
        '  cat "$XDG_CONFIG_HOME/gh/hosts.yml"; cat "$XDG_DATA_HOME/opencode/auth.json"; cat "$GH_CONFIG_DIR/hosts.yml";',
        '  echo "SOCK=$SSH_AUTH_SOCK GH=$GH_TOKEN GITCFG=$GIT_CONFIG_GLOBAL"; } 2>/dev/null | tr "\\n\\"" "  ")',
        'printf \'{"type":"text","part":{"text":"%s HOME=%s"}}\\n\' "$OUT" "$HOME"',
      ].join("\n"),
      { mode: 0o755 }
    );
    const result = await runNativeProvider({
      workspacePath: ws,
      prompt: "read secrets",
      command: script,
      model: "anthropic/claude-sonnet",
      timeoutMs: 20_000,
      opencodeCacheDir: path.join(bin, "cache"),
    });
    expect(result.status).toBe("completed");
    for (const secret of Object.values(PLANTED)) expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("planted-agent.sock");
    expect(result.output).not.toContain(`HOME=${realHome} `);
    expect(result.output).toContain("GITCFG=/dev/null");
    // The one login the run needs is there (the copy works).
    expect(result.output).toContain("the-one-needed");
  });
});
