import { afterEach, describe, expect, test } from "vitest";
import { loadPolicy } from "@/orchestrator/policy";
import { applyAppSettings, resetAppSettingsForTest, syncAppSettings } from "@/services/appSettings";
import { assertPushAllowed } from "@/tools/gitPush";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { gitIdentity } from "@/api/convex/lib/gitIdentity";

afterEach(() => resetAppSettingsForTest());

describe("Settings modal → worker", () => {
  test("knob overrides reload the shared policy in place (bounds kept)", () => {
    const policy = loadPolicy();
    const target = { policy, workspaceRoot: "./workspaces" };
    const maxConcurrency = policy.maxConcurrency;
    const changed = applyAppSettings(
      {
        values: {
          ORCHESTRATOR_WORKTREE_ISOLATION: "true",
          ORCHESTRATOR_QA_MODE: "never",
          ORCHESTRATOR_TOOL_LOOP: "true",
          ORCHESTRATOR_APPROVAL_TIMEOUT_MS: "120000",
          WORKSPACE_ROOT: "/srv/fhara",
        },
        childEnv: {},
        updatedAt: 1,
      },
      target
    );
    expect(changed).toBe(true);
    expect(policy.worktreeIsolation).toBe(true);
    expect(policy.qaMode).toBe("never");
    expect(policy.toolLoop).toBe(true);
    expect(policy.approvalTimeoutMs).toBe(120_000);
    expect(policy.maxConcurrency).toBe(maxConcurrency);
    expect(target.workspaceRoot).toBe("/srv/fhara");
    // Same version: not applied twice.
    expect(applyAppSettings({ values: {}, childEnv: {}, updatedAt: 1 }, target)).toBe(false);
  });

  test("push guard, git identity and child env follow the overrides", () => {
    const policy = loadPolicy();
    expect(() => assertPushAllowed({ branchName: "main", force: false })).toThrow(/base branch/);
    applyAppSettings(
      {
        values: { FHARA_ALLOW_BASE_BRANCH_PUSH: "true", FHARA_GIT_AUTHOR_EMAIL: "me@example.com" },
        childEnv: { DATABASE_URL: "postgres://local", CONVEX_SERVICE_TOKEN: "nope" },
        updatedAt: 2,
      },
      { policy, workspaceRoot: "." }
    );
    expect(() => assertPushAllowed({ branchName: "main" })).not.toThrow();
    expect(() => assertPushAllowed({ branchName: "feature", force: true })).toThrow(/force push/);
    expect(gitIdentity().email).toBe("me@example.com");
    const env = buildChildEnv();
    expect(env.DATABASE_URL).toBe("postgres://local");
    expect(env.CONVEX_SERVICE_TOKEN).toBeUndefined();
  });

  test("a failed fetch keeps the last values and does not throw", async () => {
    const logs: string[] = [];
    const target = { policy: loadPolicy(), workspaceRoot: "." };
    await syncAppSettings(
      { getAppSettings: async () => Promise.reject(new Error("offline")) } as never,
      target,
      (...args: unknown[]) => logs.push(args.join(" "))
    );
    expect(logs[0]).toMatch(/settings fetch failed: offline/);
  });
});
