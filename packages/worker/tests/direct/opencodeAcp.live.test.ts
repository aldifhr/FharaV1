/**
 * Live check against a real `opencode acp` (skipped unless
 * FHARA_LIVE_OPENCODE is the absolute path of an opencode binary; uses
 * OpenCode's free default model, so it needs network). A repo whose own
 * opencode.json says `permission: allow` must still ask before writing,
 * and a denied write must not happen.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { ThreadRunner, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import { OPENCODE_ACP_ARGS, opencodeEnv } from "@/vendor/threadbear/acp/agents";
import { silentLogger } from "@/vendor/threadbear/acp/connection";

const BIN = process.env.FHARA_LIVE_OPENCODE;

describe.skipIf(!BIN)("opencode acp (live)", () => {
  it("asks for a write despite the repo's permission: allow, and a denied write does not happen", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-acp-live-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "opencode.json"), JSON.stringify({ permission: "allow" }));
    const events: Array<StoredEvent & { seq: number }> = [];
    const asked: string[] = [];
    const store: DirectStore = {
      appendEvents: async (batch) => batch.map((e) => (events.push({ ...e, seq: events.length + 1 }), events.length)),
      flushStream: async () => undefined,
      clearStreams: async () => undefined,
      requestApproval: async ({ request }) => {
        asked.push(`${request.acpKind}:${request.title}`);
        return { status: "pending", approvalId: `a${asked.length}`, reason: "test" };
      },
      approvalState: async () => ({ status: "rejected", decision: "deny", note: null, taskStatus: "running" }),
      cancelApproval: async () => undefined,
      loadEvents: async () => [],
      recordUsage: async () => undefined,
    };
    const env = { ...process.env } as Record<string, string | undefined>;
    const engine = new AcpEngine({ binary: BIN!, args: OPENCODE_ACP_ARGS, env: { ...env, ...opencodeEnv({ source: env }) }, log: silentLogger, workspaceRoot: repo });
    const runner = new ThreadRunner({ taskId: "live", cwd: repo, engine, store, approvalPollMs: 50 });
    try {
      await runner.deliver({ seq: 1, text: "Create a file hello.txt containing hi using your write tool. Do nothing else." });
      await runner.idle();
      await runner.drain();
      expect(asked.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(repo, "hello.txt"))).toBe(false);
      expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    } finally {
      await runner.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 180_000);
});
