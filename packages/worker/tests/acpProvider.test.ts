import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acpArgs,
  acpCommand,
  acpDispositionForRequest,
  acpOutcomeForDisposition,
  acpPathAllowed,
  runAcpProvider,
} from "@/execution/acpProvider";
import { buildOpencodePolicy, READ_ONLY_OPENCODE_POLICY, type OpencodePolicy } from "@/execution/opencodePolicy";

const MUTATING_POLICY: OpencodePolicy = buildOpencodePolicy({
  permissions: { read: true, write: true, shell: "none", web: false, push: false, options: false },
  mutating: true,
  allowedPaths: ["src/**"],
});

const commandSubject = (command: string) => ({ type: "command", command, cwd: "/nowhere" });
const toolCallSubject = (toolCall: Record<string, unknown>) => ({ type: "tool_call", toolCall });

describe("acpCommand / acpArgs", () => {
  it("defaults to claude-code-acp with no args", () => {
    expect(acpCommand({})).toBe("claude-code-acp");
    expect(acpArgs({})).toEqual([]);
  });

  it("parses literal argv from a JSON array and ignores anything else", () => {
    expect(acpArgs({ ORCHESTRATOR_ACP_ARGS: '["--profile","acp"]' })).toEqual(["--profile", "acp"]);
    expect(acpArgs({ ORCHESTRATOR_ACP_ARGS: "--profile acp" })).toEqual([]);
    expect(acpArgs({ ORCHESTRATOR_ACP_ARGS: "[]" })).toEqual([]);
  });
});

describe("acpDispositionForRequest", () => {
  const allow = (policy: OpencodePolicy, subject: unknown, mutating = false) =>
    acpDispositionForRequest(policy, subject, { mutating, workspaceRoot: "D:/work/root" }).disposition;

  it("denies bash commands unless the policy allowlists them", () => {
    expect(allow(READ_ONLY_OPENCODE_POLICY, commandSubject("npm run test"))).toBe("deny");
    const bashAllowed: OpencodePolicy = buildOpencodePolicy({
      permissions: { read: true, write: false, shell: "allowlist", web: false, push: false, options: false },
      mutating: false,
    });
    expect(allow(bashAllowed, commandSubject("npm run test"), false)).toBe("allow");
    // Even an allowlisted shell role cannot push.
    expect(allow(bashAllowed, commandSubject("git push origin main"), false)).toBe("deny");
  });

  it("allows in-worktree reads and denies reads outside the workspace", () => {
    expect(allow(READ_ONLY_OPENCODE_POLICY, toolCallSubject({ kind: "read", locations: [{ path: "src/a.ts" }] }))).toBe("allow");
    expect(allow(READ_ONLY_OPENCODE_POLICY, toolCallSubject({ kind: "read", locations: [{ path: "../outside.txt" }] }))).toBe("deny");
    // Sensitive paths are denied through the same rule maps OpenCode uses.
    expect(allow(READ_ONLY_OPENCODE_POLICY, toolCallSubject({ kind: "read", locations: [{ path: ".env" }] }))).toBe("deny");
  });

  it("denies edits for read-only runs even with a permissive policy", () => {
    expect(
      allow(MUTATING_POLICY, toolCallSubject({ kind: "edit", locations: [{ path: "src/a.ts" }] }), false)
    ).toBe("deny");
  });

  it("allows in-scope edits for mutating runs and denies out-of-scope ones", () => {
    expect(allow(MUTATING_POLICY, toolCallSubject({ kind: "edit", locations: [{ path: "src/a.ts" }] }), true)).toBe("allow");
    expect(allow(MUTATING_POLICY, toolCallSubject({ kind: "delete", locations: [{ path: "docs/readme.md" }] }), true)).toBe("deny");
  });

  it("denies unknown tool kinds and unknown subject types", () => {
    expect(allow(READ_ONLY_OPENCODE_POLICY, toolCallSubject({ kind: "execute", rawInput: { command: "rm -rf /" } }))).toBe("deny");
    expect(allow(READ_ONLY_OPENCODE_POLICY, { type: "something_custom" })).toBe("deny");
    expect(allow(READ_ONLY_OPENCODE_POLICY, null)).toBe("deny");
  });

  it("denies web fetch unless the role has web access", () => {
    expect(allow(READ_ONLY_OPENCODE_POLICY, toolCallSubject({ kind: "fetch", rawInput: { url: "https://example.com" } }))).toBe("deny");
  });
});

describe("acpOutcomeForDisposition", () => {
  const options = [
    { optionId: "opt-allow", kind: "allow_once" },
    { optionId: "opt-allow-always", kind: "allow_always" },
    { optionId: "opt-reject", kind: "reject_once" },
  ];

  it("selects the agent's own allow option for an allow verdict", () => {
    expect(acpOutcomeForDisposition(options, "allow")).toEqual({ outcome: "selected", optionId: "opt-allow" });
  });

  it("selects the agent's own reject option for a deny verdict", () => {
    expect(acpOutcomeForDisposition(options, "deny")).toEqual({ outcome: "selected", optionId: "opt-reject" });
  });

  it("answers cancelled when the agent offers no matching option (decline without fabrication)", () => {
    expect(acpOutcomeForDisposition([{ optionId: "opt-allow", kind: "allow_once" }], "deny")).toEqual({
      outcome: "cancelled",
    });
  });
});

describe("acpPathAllowed", () => {
  const root = path.resolve("D:/work/root");

  it("allows a read inside the workspace and rejects escapes", () => {
    expect(acpPathAllowed(READ_ONLY_OPENCODE_POLICY, "read", path.join(root, "src/a.ts"), root)).toMatchObject({
      ok: true,
    });
    expect(acpPathAllowed(READ_ONLY_OPENCODE_POLICY, "read", "D:/elsewhere/x.ts", root).ok).toBe(false);
  });

  it("denies sensitive paths through the read rule map", () => {
    expect(acpPathAllowed(READ_ONLY_OPENCODE_POLICY, "read", path.join(root, ".env"), root).ok).toBe(false);
    expect(acpPathAllowed(READ_ONLY_OPENCODE_POLICY, "read", path.join(root, "server.key"), root).ok).toBe(false);
  });

  it("denies edits unless the edit map allows the path", () => {
    expect(acpPathAllowed(READ_ONLY_OPENCODE_POLICY, "edit", path.join(root, "src/a.ts"), root).ok).toBe(false);
    expect(acpPathAllowed(MUTATING_POLICY, "edit", path.join(root, "src/a.ts"), root).ok).toBe(true);
    expect(acpPathAllowed(MUTATING_POLICY, "edit", path.join(root, "docs/readme.md"), root).ok).toBe(false);
  });
});

describe("runAcpProvider (fake ACP agent over stdio)", () => {
  const helper = path.join(import.meta.dirname, "helpers", "fakeAcpAgent.mjs");
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-acp-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "hello from a", "utf-8");
    await fs.writeFile(path.join(root, ".env"), "SECRET=1", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("runs a prompt turn and reports the collected text and usage", async () => {
    const chunks: string[] = [];
    const result = await runAcpProvider({
      workspacePath: root,
      prompt: "hello",
      command: "node",
      args: [helper],
      policy: READ_ONLY_OPENCODE_POLICY,
      mutating: false,
      timeoutMs: 30_000,
      onChunk: async (delta) => {
        chunks.push(delta);
      },
    });
    expect(result.status).toBe("completed");
    expect(result.output).toContain("Pong");
    expect(chunks.join("")).toContain("Pong");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.cachedInputTokens).toBe(4);
    expect(result.reasoningTokens).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("answers a permission request with the agent's own reject option and logs the denial", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await runAcpProvider({
      workspacePath: root,
      prompt: "PERM: please run something",
      command: "node",
      args: [helper],
      policy: READ_ONLY_OPENCODE_POLICY,
      mutating: false,
      timeoutMs: 30_000,
      onEvent: async (type, payload) => {
        events.push({ type, payload });
      },
    });
    expect(result.status).toBe("completed");
    // The fake agent echoes the outcome it received.
    expect(result.output).toContain('"outcome":"selected"');
    expect(result.output).toContain("opt-reject");
    const denial = events.find((e) => e.type === "agent.permission_denied");
    expect(denial).toBeDefined();
    expect(String(denial?.payload.reason)).toContain("policy denies command");
  }, 30_000);

  it("serves sandboxed reads through the fs handler and echoes the content", async () => {
    const result = await runAcpProvider({
      workspacePath: root,
      prompt: `READFILE: ${path.join(root, "src", "a.ts")}`,
      command: "node",
      args: [helper],
      policy: READ_ONLY_OPENCODE_POLICY,
      mutating: false,
      timeoutMs: 30_000,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toContain("read result: hello from a");
  }, 30_000);

  it("refuses a sensitive-path read (.env) through the fs handler", async () => {
    const result = await runAcpProvider({
      workspacePath: root,
      prompt: `READFILE: ${path.join(root, ".env")}`,
      command: "node",
      args: [helper],
      policy: READ_ONLY_OPENCODE_POLICY,
      mutating: false,
      timeoutMs: 30_000,
    });
    expect(result.status).toBe("completed");
    // The client answered the fs request with a protocol error, so the
    // agent never sees the secret.
    expect(result.output).toContain("read result: error:");
    expect(result.output).not.toContain("SECRET");
  }, 30_000);

  it("fails the fs write handler for a read-only run and never touches the file", async () => {
    const target = path.join(root, "src", "b.ts");
    const result = await runAcpProvider({
      workspacePath: root,
      prompt: `WRITEFILE: ${target}`,
      command: "node",
      args: [helper],
      policy: READ_ONLY_OPENCODE_POLICY,
      mutating: false,
      timeoutMs: 30_000,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toContain("write error:");
    await expect(fs.readFile(target, "utf-8")).rejects.toThrow();
  }, 30_000);

  it("writes through the fs handler only inside the allowed scope for a mutating run", async () => {
    const target = path.join(root, "src", "b.ts");
    const outside = path.join(root, "docs", "c.md");
    const results = await Promise.all([
      runAcpProvider({
        workspacePath: root,
        prompt: `WRITEFILE: ${target}`,
        command: "node",
        args: [helper],
        policy: MUTATING_POLICY,
        mutating: true,
        timeoutMs: 30_000,
      }),
      runAcpProvider({
        workspacePath: root,
        prompt: `WRITEFILE: ${outside}`,
        command: "node",
        args: [helper],
        policy: MUTATING_POLICY,
        mutating: true,
        timeoutMs: 30_000,
      }),
    ]);
    expect(results[0]?.output).toContain("write ok");
    await expect(fs.readFile(target, "utf-8")).resolves.toBe("written by fake agent\n");
    expect(results[1]?.output).toContain("write error:");
    await expect(fs.readFile(outside, "utf-8")).rejects.toThrow();
  }, 45_000);
});

describe("nativeRun routing (driver acp)", () => {
  it("routes the acp driver to the ACP runtime end to end", async () => {
    const { runNativeDriver } = await import("@/execution/nativeRun");
    const { resetAcpAvailabilityCache } = await import("@/execution/acpProvider");
    const helper = path.join(import.meta.dirname, "helpers", "fakeAcpAgent.mjs");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-acp-route-"));
    const prevArgs = process.env.ORCHESTRATOR_ACP_ARGS;
    process.env.ORCHESTRATOR_ACP_ARGS = JSON.stringify([helper]);
    resetAcpAvailabilityCache();
    try {
      const result = await runNativeDriver({
        driver: "acp",
        workspacePath: root,
        prompt: "hello",
        acpCommand: "node",
        policy: READ_ONLY_OPENCODE_POLICY,
        mutating: false,
        timeoutMs: 30_000,
      });
      expect(result.status).toBe("completed");
      expect(result.output).toContain("Pong");
    } finally {
      if (prevArgs === undefined) delete process.env.ORCHESTRATOR_ACP_ARGS;
      else process.env.ORCHESTRATOR_ACP_ARGS = prevArgs;
      resetAcpAvailabilityCache();
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
