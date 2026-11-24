import { afterEach, describe, expect, test } from "vitest";
import * as path from "node:path";
import { WORKER_DIR } from "@/utils/rootEnv";
import { loadPolicy } from "@/orchestrator/policy";
import { applyAppSettings, knobEnvSnapshot, resetAppSettingsForTest, syncAppSettings } from "@/services/appSettings";
import { assertPushAllowed } from "@/tools/gitPush";
import { buildChildEnv } from "@/api/functions/lib/childEnv";
import { gitIdentity } from "@/api/functions/lib/gitIdentity";

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
    // The override is absolute; path.resolve keeps it on the host's native
    // form ("/srv/fhara" on POSIX, "D:\\srv\\fhara" on Windows).
    expect(target.workspaceRoot).toBe(path.resolve(WORKER_DIR, "/srv/fhara"));
    // Same version: not applied twice.
    expect(applyAppSettings({ values: {}, childEnv: {}, updatedAt: 1 }, target)).toBe(false);
  });

  test("push guard, git identity and child env follow the overrides", () => {
    const policy = loadPolicy();
    expect(() => assertPushAllowed({ branchName: "main", force: false })).toThrow(/base branch/);
    applyAppSettings(
      {
        values: { FHARA_ALLOW_BASE_BRANCH_PUSH: "true", FHARA_GIT_AUTHOR_EMAIL: "me@example.com" },
        childEnv: { DATABASE_URL: "postgres://local", FHARA_SERVICE_TOKEN: "nope" },
        updatedAt: 2,
      },
      { policy, workspaceRoot: "." }
    );
    expect(() => assertPushAllowed({ branchName: "main" })).not.toThrow();
    expect(() => assertPushAllowed({ branchName: "feature", force: true })).toThrow(/force push/);
    expect(gitIdentity().email).toBe("me@example.com");
    const env = buildChildEnv();
    expect(env.DATABASE_URL).toBe("postgres://local");
    expect(env.FHARA_SERVICE_TOKEN).toBeUndefined();
  });

  test("the env report carries worker knobs only", () => {
    expect(
      knobEnvSnapshot({ QA_CHROMIUM_PATH: "/usr/bin/chromium", FHARA_PR_FIX_MAX_ATTEMPTS: "5", FHARA_SERVICE_TOKEN: "x", ORCHESTRATOR_TOOL_LOOP: "" })
    ).toEqual([{ key: "QA_CHROMIUM_PATH", value: "/usr/bin/chromium" }]);
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
