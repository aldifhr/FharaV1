/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  normalizeChildEnv,
  normalizeSettingValue,
  setChildEnvOverrides,
  setSettingOverrides,
  settingEnv,
  settingFrom,
} from "./lib/appSettings";
import { buildChildEnv } from "./lib/childEnv";
import { gitIdentity } from "./lib/gitIdentity";
import { buildContextSnapshot } from "./lib/contextSnapshot";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  setSettingOverrides({});
  setChildEnvOverrides({});
});

describe("settings knobs (pure)", () => {
  test("values are normalized per type and unknown keys are refused", () => {
    expect(normalizeSettingValue("FHARA_ALLOW_FORCE_PUSH", "ON")).toBe("true");
    expect(normalizeSettingValue("FHARA_ALLOW_FORCE_PUSH", "0")).toBe("false");
    expect(normalizeSettingValue("FHARA_WORKTREE_RETENTION_HOURS", "9999")).toBe("720");
    expect(normalizeSettingValue("FHARA_WORKTREE_RETENTION_HOURS", "0")).toBe("1");
    expect(normalizeSettingValue("ORCHESTRATOR_QA_MODE", "Never")).toBe("never");
    expect(normalizeSettingValue("FHARA_GIT_AUTHOR_NAME", "  ")).toBe("");
    expect(() => normalizeSettingValue("ORCHESTRATOR_QA_MODE", "sometimes")).toThrow(/one of/);
    expect(() => normalizeSettingValue("CONVEX_SERVICE_TOKEN", "x")).toThrow(/Unknown setting/);
    expect(() => normalizeSettingValue("FHARA_ALLOW_FORCE_PUSH", "maybe")).toThrow(/true or false/);
  });

  test("overrides win over the process env for settingEnv and gitIdentity", () => {
    expect(settingEnv("FHARA_GIT_AUTHOR_NAME")).toBe(process.env.FHARA_GIT_AUTHOR_NAME);
    setSettingOverrides({ FHARA_GIT_AUTHOR_NAME: "Faray", NOT_A_KNOB: "x" });
    expect(settingEnv("FHARA_GIT_AUTHOR_NAME")).toBe("Faray");
    expect(settingEnv("NOT_A_KNOB")).toBe(process.env.NOT_A_KNOB);
    expect(gitIdentity().name).toBe("Faray");
  });

  test("settingFrom prefers the stored value, then the env", () => {
    expect(settingFrom({ FHARA_PR_FIX_MAX_ATTEMPTS: "5" }, "FHARA_PR_FIX_MAX_ATTEMPTS")).toBe("5");
    expect(settingFrom({}, "FHARA_PR_FIX_MAX_ATTEMPTS")).toBe(process.env.FHARA_PR_FIX_MAX_ATTEMPTS);
  });

  test("child env: user vars reach buildChildEnv, secrets never do", () => {
    expect(() => normalizeChildEnv([{ name: "CONVEX_SERVICE_TOKEN", value: "x" }])).toThrow(/can not be set/);
    expect(() => normalizeChildEnv([{ name: "1BAD", value: "x" }])).toThrow(/Invalid variable name/);
    expect(() => normalizeChildEnv([{ name: "A", value: "1" }, { name: "A", value: "2" }])).toThrow(/Duplicate/);
    expect(normalizeChildEnv([{ name: " DATABASE_URL ", value: "postgres://x" }, { name: "", value: "" }])).toEqual([
      { name: "DATABASE_URL", value: "postgres://x" },
    ]);
    setChildEnvOverrides({ DATABASE_URL: "postgres://x", CONVEX_SERVICE_TOKEN: "leak", PROVIDER_ENCRYPTION_KEY: "leak" });
    const env = buildChildEnv({}, { source: { PATH: "/bin" } });
    expect(env.DATABASE_URL).toBe("postgres://x");
    expect(env.CONVEX_SERVICE_TOKEN).toBeUndefined();
    expect(env.PROVIDER_ENCRYPTION_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

describe("appSettings (Convex)", () => {
  test("setValue stores, get reads back, an empty value clears", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.appSettings.setValue, { key: "FHARA_PR_DRAFT", value: "off" });
    let settings = await t.query(api.appSettings.get, {});
    expect(settings.knobs.FHARA_PR_DRAFT.override).toBe("false");
    const worker = await t.query(internal.appSettings.forWorker, {});
    expect(worker.values).toEqual({ FHARA_PR_DRAFT: "false" });

    await t.mutation(api.appSettings.setValue, { key: "FHARA_PR_DRAFT", value: "" });
    settings = await t.query(api.appSettings.get, {});
    expect(settings.knobs.FHARA_PR_DRAFT.override).toBeNull();
    expect(settings.knobs.FHARA_PR_DRAFT.defaultValue).toBe("true");
    await expect(t.mutation(api.appSettings.setValue, { key: "WORKER_ID", value: "x" })).rejects.toThrow(/Unknown setting/);
    const audits = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audits.filter((a) => a.action === "settings.update").length).toBe(2);
  });

  test("child env is validated and delivered to the worker", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.appSettings.setChildEnv, { entries: [{ name: "FOO", value: "bar" }] });
    expect((await t.query(internal.appSettings.forWorker, {})).childEnv).toEqual({ FOO: "bar" });
    await expect(
      t.mutation(api.appSettings.setChildEnv, { entries: [{ name: "GIT_DIR", value: "/tmp" }] })
    ).rejects.toThrow(/can not be set/);
  });

  test("new-project defaults apply when projects.create omits the field", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.appSettings.setNewProjectDefaults, {
      defaultBaseBranch: "develop",
      defaultPermissionMode: "auto_edits",
      planReview: "always",
      prFeedbackReactions: true,
      shadowAgentDefault: true,
    });
    const projectId = await t.mutation(api.projects.create, { name: "Demo", workspacePath: "/tmp/demo" });
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.mainBranch).toBe("develop");
    expect(project?.defaultPermissionMode).toBe("auto_edits");
    expect(project?.planReview).toBe("always");
    expect(project?.prFeedbackReactions).toBe(true);
    expect(project?.shadowAgentDefault).toBe(true);

    // An explicit value still wins; clearing a default stops applying it.
    await t.mutation(api.appSettings.setNewProjectDefaults, { defaultPermissionMode: null, prFeedbackReactions: false });
    const second = await t.mutation(api.projects.create, {
      name: "Two",
      workspacePath: "/tmp/two",
      mainBranch: "main",
    });
    const two = await t.run((ctx) => ctx.db.get(second));
    expect(two?.mainBranch).toBe("main");
    expect(two?.defaultPermissionMode).toBeUndefined();
    expect(two?.prFeedbackReactions).toBeUndefined();
    await expect(t.mutation(api.appSettings.setNewProjectDefaults, { defaultBaseBranch: "bad..name" })).rejects.toThrow();
  });

  test("the snapshot switch in Settings stops recording", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.mutation(api.projects.create, { name: "Snap", workspacePath: "/tmp/snap" });
    const { meta, body } = buildContextSnapshot({
      callRole: "executor",
      messages: [{ role: "user", content: "do it" }],
      response: "ok",
    });
    const args = { projectId, source: "worker" as const, meta, body };
    expect(await t.mutation(internal.contextSnapshots.record, args)).not.toBeNull();
    await t.mutation(api.appSettings.setValue, { key: "CONTEXT_SNAPSHOTS", value: "false" });
    expect(await t.mutation(internal.contextSnapshots.record, args)).toBeNull();
  });

  test("worker knobs show the worker's reported env, API knobs never take it", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("workers", { workerId: "w1", capacity: 1, activeTasks: 0, status: "online", lastHeartbeatAt: Date.now() })
    );
    await t.mutation(internal.appSettings.reportKnobEnv, {
      workerId: "w1",
      values: [
        { key: "ORCHESTRATOR_WORKTREE_ISOLATION", value: "true" },
        { key: "FHARA_WORKTREE_RETENTION_HOURS", value: "1" },
        { key: "CONVEX_SERVICE_TOKEN", value: "secret" },
      ],
    });
    const settings = await t.query(api.appSettings.get, {});
    expect(settings.knobs.ORCHESTRATOR_WORKTREE_ISOLATION.env).toBe("true");
    expect(settings.knobs.FHARA_WORKTREE_RETENTION_HOURS.env).toBe(process.env.FHARA_WORKTREE_RETENTION_HOURS ?? null);
    const row = await t.run((ctx) => ctx.db.query("workers").first());
    expect(row?.knobEnv?.map((e) => e.key)).toEqual(["ORCHESTRATOR_WORKTREE_ISOLATION"]);
  });

  test("offline workers can be forgotten; online ones stay", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("workers", { workerId: "a", capacity: 1, activeTasks: 0, status: "online", lastHeartbeatAt: Date.now() });
      await ctx.db.insert("workers", { workerId: "b", capacity: 1, activeTasks: 0, status: "offline", lastHeartbeatAt: 1 });
    });
    expect((await t.query(api.appSettings.workers, {})).map((w) => w.workerId)).toEqual(["a", "b"]);
    expect(await t.mutation(api.appSettings.forgetOfflineWorkers, {})).toBe(1);
    expect((await t.query(api.appSettings.workers, {})).map((w) => w.workerId)).toEqual(["a"]);
  });

  test("G10: the status line shows the worst host pressure an online worker reports", async () => {
    const t = convexTest(schema, modules);
    const beat = (workerId: string, capabilities: string[]) =>
      t.mutation(internal.orchestration.heartbeat, { workerId, hostname: workerId, capacity: 1, activeTasks: 0, capabilities });
    await beat("a", ["repoTools"]);
    expect(await t.query(api.appSettings.hostPressure, {})).toBeNull();
    await beat("b", ["repoTools", "pressure:warn:memory"]);
    expect(await t.query(api.appSettings.hostPressure, {})).toEqual({ level: "warn", resources: ["memory"], hostname: "b" });
    await beat("a", ["pressure:critical:disk,load"]);
    expect(await t.query(api.appSettings.hostPressure, {})).toEqual({ level: "critical", resources: ["disk", "load"], hostname: "a" });
    // An offline worker's last report does not count.
    await t.run(async (ctx) => {
      for (const w of await ctx.db.query("workers").collect()) await ctx.db.patch(w._id, { status: "offline" as const });
    });
    expect(await t.query(api.appSettings.hostPressure, {})).toBeNull();
  });
});

describe("cron wrappers", () => {
  test("a mutation job records its last run; Run now records a manual run", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.cronJobs.sweepStaleChatReplies, {});
    let jobs = await t.query(api.cronJobs.list, {});
    const sweep = jobs.find((j) => j.name === "sweep stale chat replies");
    expect(sweep?.lastStatus).toBe("ok");
    expect(sweep?.runCount).toBe(1);
    expect(sweep?.trigger).toBe("cron");

    await t.mutation(internal.cronJobs.sweepStaleChatReplies, { trigger: "manual" });
    jobs = await t.query(api.cronJobs.list, {});
    expect(jobs.find((j) => j.name === "sweep stale chat replies")?.runCount).toBe(2);
    expect(jobs.find((j) => j.name === "task watchdog")?.lastStatus).toBeNull();
    await expect(t.mutation(api.cronJobs.runNow, { name: "rm -rf" })).rejects.toThrow(/Unknown scheduled task/);
  });
});

describe("archive", () => {
  test("a closed personal chat can be restored (replacing the active one) and deleted", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true })
    );
    const ids = await t.run(async (ctx) => {
      const closed = await ctx.db.insert("conversations", {
        kind: "personal",
        agentId,
        status: "closed",
        createdAt: 1,
        updatedAt: 2,
      });
      const active = await ctx.db.insert("conversations", {
        kind: "personal",
        agentId,
        status: "active",
        createdAt: 3,
      });
      await ctx.db.insert("messages", { conversationId: closed, authorType: "user", content: "hello there" });
      return { closed, active };
    });
    const listed = await t.query(api.archive.list, {});
    expect(listed.map((r) => r._id)).toEqual([ids.closed]);
    expect(listed[0].preview).toBe("hello there");

    await t.mutation(api.archive.restore, { conversationId: ids.closed });
    const after = await t.run(async (ctx) => [await ctx.db.get(ids.closed), await ctx.db.get(ids.active)]);
    expect(after[0]?.status).toBe("active");
    expect(after[1]?.status).toBe("closed");

    // The restored one is active now, so it can not be deleted from here.
    await expect(t.mutation(api.archive.remove, { conversationId: ids.closed })).rejects.toThrow(/not archived/);
    await t.run((ctx) => ctx.db.insert("messages", { conversationId: ids.active, authorType: "user", content: "x" }));
    const removed = await t.mutation(api.archive.remove, { conversationId: ids.active });
    expect(removed).toEqual({ deletedMessages: 1, more: false });
    expect(await t.run((ctx) => ctx.db.get(ids.active))).toBeNull();
  });
});
