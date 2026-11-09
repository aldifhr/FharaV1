import type { WorkerApi, WorkerTask } from "@/workerApi";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import type { RunnerDeps } from "@/services/taskRunner";
import { withApiDefaults } from "./fakeApi";

export { API_DEFAULTS, withApiDefaults } from "./fakeApi";

/**
 * A fake WorkerApi for runner tests: every method the task runner calls
 * has a benign default, `completeTask` inputs are recorded in
 * `completions`, and `overrides` replace any default (getContext usually).
 */
export function createFakeApi(overrides: Record<string, unknown> = {}) {
  const completions: Array<Record<string, unknown>> = [];
  const api = withApiDefaults({
    logEvent: async () => undefined,
    startExecution: async () => "exec-1",
    updateExecution: async () => undefined,
    updateSubtask: async () => true,
    saveFileChange: async () => "change-1",
    markFilesApplied: async () => undefined,
    getFileChanges: async () => [],
    getApprovals: async () => [],
    recordAudit: async () => undefined,
    recordEvaluation: async () => undefined,
    completeTask: async (input: Record<string, unknown>) => {
      completions.push(input);
    },
    appendAgentMessage: async () => undefined,
    recordTokenUsage: async () => undefined,
    setPlanning: async () => undefined,
    savePlan: async () => 1,
    requestApproval: async () => "approval-1",
    ...overrides,
  });
  return { api, completions };
}

/** RunnerDeps around a fake api (cast at the boundary, once). */
export function createRunnerDeps(input: {
  api: object;
  policy: ExecutionPolicy;
  workspaceRoot: string;
  workerId?: string;
}): RunnerDeps {
  return {
    api: input.api as unknown as WorkerApi,
    workerId: input.workerId ?? "test-worker",
    policy: input.policy,
    workspaceRoot: input.workspaceRoot,
    log: () => undefined,
  };
}

/** The minimal task row the runner tests feed processTask. */
export function testTask(fields: { command: string; title?: string; status?: string; _id?: string; projectId?: string } & Record<string, unknown>) {
  return {
    _id: "task-1",
    projectId: "project-1",
    title: fields.command,
    status: "running",
    ...fields,
  } as unknown as WorkerTask & Record<string, unknown>;
}
