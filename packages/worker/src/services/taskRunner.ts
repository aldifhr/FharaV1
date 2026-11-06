import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkerApi } from "../workerApi";
import type {
  WorkerAgent,
  WorkerFileChange,
  WorkerProject,
  WorkerSubtask,
  WorkerTask,
} from "../workerApi";
import {
  CAPABILITY,
  type AgentDefinition,
  type ExecutionPlan,
  type PlanSubtask,
  type SubtaskKind,
} from "../orchestrator/types";
import { classifyCommand } from "../orchestrator/classifier";
import { createPlan, heuristicPlan } from "../orchestrator/planner";
import { validatePlan } from "../orchestrator/planValidator";
import type { ExecutionPolicy } from "../orchestrator/policy";
import { capabilitiesOf, routeCapability } from "../orchestrator/capabilities";
import {
  buildReviewFixSubtask,
  collectRequestedChanges,
  formatReviewFindings,
} from "../orchestrator/reviewLoop";
import type { ReviewResult } from "../utils/json";
import { executeSubtask } from "../execution/agentExecutor";
import { runVerification } from "../execution/verification";
import {
  runScheduler,
  type NodeOutcome,
  type SchedulerResult,
} from "../scheduler/dagScheduler";
import {
  evaluateTask,
  type EvaluationCheck,
  type EvaluationResult,
} from "../orchestrator/evaluator";
import {
  applyFileChange,
  hashContent,
  type FileDiff,
} from "../tools/gitDiff";

export interface RunnerDeps {
  api: WorkerApi;
  workerId: string;
  policy: ExecutionPolicy;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
}

interface RunState {
  priorOutputs: Map<string, string>;
  qaVerdicts: Record<string, "passed" | "failed" | "inconclusive">;
  reviewVerdicts: Record<string, ReviewResult>;
  fileChanges: Map<string, FileDiff>;
  feedback: string[];
}

export async function processTask(task: WorkerTask, deps: RunnerDeps): Promise<void> {
  const context = await deps.api.getContext(task._id);
  if (!context?.project) {
    await deps.api.completeTask(task._id, "failed", "Project not found for task");
    return;
  }
  const { project, agents, approvalMode } = context;
  if (agents.length === 0) {
    await deps.api.completeTask(task._id, "failed", "No agents are assigned to this project");
    return;
  }

  let workspacePath = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
  await fs.mkdir(workspacePath, { recursive: true });

  let branchName: string | undefined;
  let worktreePath: string | undefined;

  // Create isolated git worktree for this task (if repo is a git directory)
  try {
    const branch = await deps.api.createBranch({ taskId: task._id, projectId: project._id });
    branchName = branch.branchName;
    worktreePath = branch.worktreePath;
    if (worktreePath) workspacePath = worktreePath;
    await fs.mkdir(workspacePath, { recursive: true });
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "branch.created",
      payload: { branchName, worktreePath },
      level: "info",
    });
  } catch (err: any) {
    // If worktree creation fails (not a git repo, etc.), fall back to main workspace
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "branch.creation_skipped",
      payload: { reason: err.message },
      level: "warn",
    });
  }

  const runAgents = agents.map(toAgentDefinition);
  const classification = classifyCommand(task.command);
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.classified",
    payload: {
      kind: classification.kind,
      strategy: classification.strategy,
      reasons: classification.reasons,
    },
  });

  let plan: ExecutionPlan;
  let createdBy: "orchestrator" | "fallback" = "fallback";
  let planVersion: number;

  const stored = context.plan ? validatePlan(context.plan.payload, deps.policy.maxSubtasks) : null;
  if (stored?.ok && stored.plan) {
    plan = stored.plan;
    createdBy = context.plan!.createdBy;
    planVersion = context.plan!.version;
  } else {
    const created = await createPlan({
      command: task.command,
      classification,
      agents: runAgents,
      policy: deps.policy,
      onTokenUsage: async (inputTokens, outputTokens, model, agentName, agentId) => {
        if (inputTokens > 0 || outputTokens > 0) {
          await deps.api.recordTokenUsage({
            projectId: project._id,
            taskId: task._id,
            agentId,
            agentName,
            model,
            inputTokens,
            outputTokens,
          });
        }
      },
    });
    plan = created.plan;
    createdBy = created.createdBy;
    planVersion = (context.plan?.version ?? 0) + 1;
    if (created.degradedReason) {
      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "plan.degraded",
        payload: { reason: created.degradedReason.slice(0, 1000) },
        level: "warn",
      });
    }
    await persistPlan(deps, {
      taskId: task._id,
      projectId: project._id,
      plan,
      version: planVersion,
      createdBy,
      classification: classification.kind,
    });
  }

  const state: RunState = {
    priorOutputs: new Map(),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(),
    feedback: [],
  };

  let replans = task.replanCount ?? 0;
  let feedback: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "executing", planVersion },
    });

    const outcome = await executePlan({
      deps,
      task,
      project,
      workspacePath,
      agents: runAgents,
      plan,
      state,
      feedback,
      approvalMode,
      completedKeys: new Set<string>(),
    });

    if (outcome === "waiting_approval") return;

    if (outcome === "completed") {
      const after = await deps.api.getContext(task._id);
      const verification = await finalize({
        deps,
        task,
        project,
        workspacePath,
        plan,
        planVersion,
        subtasks: after?.subtasks ?? [],
        state,
      });
      if (verification.verdict === "failed" && replans < deps.policy.maxReplans) {
        replans += 1;
        feedback = `Verification failed: ${verification.checks
          .filter((check) => check.status === "failed")
          .map((check) => `${check.name}: ${check.details ?? ""}`)
          .join("; ")}`;
        const replanned = await createPlan({
          command: task.command,
          classification,
          agents: runAgents,
          policy: deps.policy,
          feedback,
        });
        plan = replanned.plan;
        planVersion += 1;
        await persistPlan(deps, {
          taskId: task._id,
          projectId: project._id,
          plan,
          version: planVersion,
          createdBy: replanned.createdBy,
          classification: classification.kind,
        });
        state.priorOutputs.clear();
        state.fileChanges.clear();
        state.qaVerdicts = {};
        state.feedback = [];
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "plan.replanned",
          payload: { replans, feedback: feedback.slice(0, 1000) },
          level: "warn",
        });
        continue;
      }
      return;
    }

    // Execution failed before any approval.
    const failureSummary =
      state.feedback.join("; ") || "Execution failed without a detailed error";
    if (replans < deps.policy.maxReplans) {
      replans += 1;
      feedback = failureSummary;
      const replanned = await createPlan({
        command: task.command,
        classification,
        agents: runAgents,
        policy: deps.policy,
        feedback,
      });
      plan = replanned.plan;
      planVersion += 1;
      await persistPlan(deps, {
        taskId: task._id,
        projectId: project._id,
        plan,
        version: planVersion,
        createdBy: replanned.createdBy,
        classification: classification.kind,
      });
      state.priorOutputs.clear();
      state.fileChanges.clear();
      state.qaVerdicts = {};
      state.feedback = [];
      await deps.api.logEvent({
        taskId: task._id,
        projectId: project._id,
        type: "plan.replanned",
        payload: { replans, feedback: failureSummary.slice(0, 1000) },
        level: "warn",
      });
      continue;
    }

    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.error",
      payload: { message: failureSummary.slice(0, 2000) },
      level: "error",
    });
    await deps.api.completeTask(task._id, "failed", failureSummary);
    return;
  }
}

async function executePlan(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  workspacePath: string;
  agents: AgentDefinition[];
  plan: ExecutionPlan;
  state: RunState;
  feedback?: string;
  approvalResolved?: boolean;
  approvalMode: "ask" | "auto";
  completedKeys: Set<string>;
}): Promise<"completed" | "failed" | "waiting_approval"> {
  const { deps, task, project, plan, state } = input;
  const implementationNodes = plan.subtasks.filter(
    (subtask) => subtask.kind !== "qa" && subtask.kind !== "review"
  );
  const reviewNodes = plan.subtasks.filter((subtask) => subtask.kind === "review");
  const qaNodes = plan.subtasks.filter((subtask) => subtask.kind === "qa");
  if (implementationNodes.length === 0 && reviewNodes.length === 0 && qaNodes.length === 0) {
    return "failed";
  }

  const executionIds = new Map<string, string>();
  const agentByKey = new Map<string, AgentDefinition>();
  const taskId = task._id;

  const assign = (key: string): AgentDefinition | null => {
    const existing = agentByKey.get(key);
    if (existing) return existing;
    const subtask = plan.subtasks.find((candidate) => candidate.key === key);
    if (!subtask) return null;
    const agent = routeCapability(subtask.capability, input.agents);
    if (agent) agentByKey.set(key, agent);
    return agent;
  };

  let lastStatusCheck = 0;
  let cancelled = false;

  const runNodes = (nodes: PlanSubtask[]): Promise<SchedulerResult> => {
    const subsetKeys = new Set(nodes.map((node) => node.key));
    return runScheduler(
      nodes.map((subtask) => ({
        id: subtask.key,
        dependencies: subtask.dependencies.filter((dependency) => subsetKeys.has(dependency)),
      })),
    async (node, signal): Promise<NodeOutcome> => {
      const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
      const agent = assign(node.id);
      if (!agent) {
        return {
          status: "failed",
          error: `No enabled agent can serve capability "${subtask.capability}"`,
        };
      }
      if (input.completedKeys.has(node.id)) {
        return { status: "completed", output: "Previously completed" };
      }
      const executionId = executionIds.get(node.id);
      return await executeSubtask({
        workspacePath: input.workspacePath,
        command: task.command,
        plan,
        subtask,
        agent,
        priorOutputs: state.priorOutputs,
        fileChanges: Array.from(state.fileChanges.values()),
        signal,
        onEvent: async (type, payload, level) => {
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type,
            payload,
            executionId,
            subtaskKey: node.id,
            level,
          });
        },
        onMessage: async (content) => {
          await deps.api.appendAgentMessage({
            projectId: project._id,
            taskId,
            agentId: agent._id,
            content,
            subtaskKey: node.id,
            executionId,
          });
        },
        onChunk: async () => {
          // Chunks are buffered by the provider; the final message is stored once.
        },
        saveFileChange: async (change) => {
          await deps.api.saveFileChange({
            taskId,
            projectId: project._id,
            filePath: change.filePath,
            changeType: change.changeType,
            oldContent: change.oldContent,
            newContent: change.newContent,
            oldContentHash: change.oldContentHash,
            newContentHash: change.newContentHash,
            diff: change.diff,
            subtaskKey: node.id,
            executionId,
          });
          state.fileChanges.set(change.filePath, change);
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type: "fileChanges.updated",
            payload: { filePaths: [change.filePath] },
            executionId,
            subtaskKey: node.id,
          });
        },
        onTokenUsage: async (inputTokens, outputTokens, model) => {
          if (inputTokens > 0 || outputTokens > 0) {
            await deps.api.recordTokenUsage({
              projectId: project._id,
              taskId,
              agentId: agent._id,
              agentName: agent.name,
              model,
              inputTokens,
              outputTokens,
            });
          }
        },
      });
    },
    {
      maxConcurrency: Math.min(plan.maxConcurrency, deps.policy.maxConcurrency),
      timeoutMs: deps.policy.subtaskTimeoutMs,
      retries: deps.policy.subtaskRetries,
      shouldCancel: async () => {
        const now = Date.now();
        if (now - lastStatusCheck < 1500) return cancelled;
        lastStatusCheck = now;
        const current = await deps.api.getContext(taskId);
        cancelled =
          !current ||
          current.task.status === "failed" ||
          current.task.status === "done" ||
          current.task.status === "rejected";
        return cancelled;
      },
      onStart: async (node, attempt) => {
        if (input.completedKeys.has(node.id)) return;
        const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
        const agent = assign(node.id);
        if (!agent) throw new Error(`No enabled agent for capability ${subtask.capability}`);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "subtask.routed",
          payload: {
            subtaskKey: node.id,
            capability: subtask.capability,
            agent: agent.name,
            capabilities: capabilitiesOf(agent),
          },
        });
        const executionId = await deps.api.startExecution({
          taskId,
          projectId: project._id,
          subtaskKey: node.id,
          agentId: agent._id,
          agentName: agent.name,
          capability: subtask.capability,
          workerId: deps.workerId,
          attempt,
          leaseMs: 60_000,
        });
        executionIds.set(node.id, executionId);
      },
      onOutcome: async (node, outcome, attempt) => {
        const agent = agentByKey.get(node.id);
        const executionId = executionIds.get(node.id);
        if (!input.completedKeys.has(node.id) && executionId) {
          await deps.api.updateExecution({
            executionId,
            subtaskKey: node.id,
            status: outcome.status === "completed" ? "completed" : "failed",
            output: outcome.status === "failed" ? undefined : outcome.output,
            error: outcome.status === "failed" ? outcome.error : undefined,
            meta: outcome.status === "failed" ? undefined : outcome.meta,
          });
        }
        const subtaskKind = plan.subtasks.find((candidate) => candidate.key === node.id)?.kind;
        const meta = outcome.meta as
          | { verdict?: string; findings?: ReviewResult["findings"] }
          | undefined;
        if (
          subtaskKind === "review" &&
          outcome.status === "completed" &&
          (meta?.verdict === "approved" || meta?.verdict === "changes_requested")
        ) {
          state.reviewVerdicts[node.id] = {
            verdict: meta.verdict,
            findings: Array.isArray(meta.findings) ? meta.findings : [],
          };
        }
        if (
          subtaskKind === "qa" &&
          (meta?.verdict === "passed" ||
            meta?.verdict === "failed" ||
            meta?.verdict === "inconclusive")
        ) {
          state.qaVerdicts[node.id] = meta.verdict;
        }
        if (outcome.status === "completed") {
          state.priorOutputs.set(node.id, outcome.output ?? "");
          return;
        }
        if (outcome.status === "failed") {
          state.feedback.push(`${node.id} (attempt ${attempt}): ${outcome.error}`);
          if (agent) {
            await deps.api.appendAgentMessage({
              projectId: project._id,
              taskId,
              agentId: agent._id,
              content: `Subtask ${node.id} failed: ${outcome.error}`,
              subtaskKey: node.id,
              executionId,
            });
          }
        }
      },
      onBlocked: async (node, reason) => {
        await deps.api.updateSubtask({
          taskId,
          key: node.id,
          status: "blocked",
          error: reason,
        });
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "subtask.blocked",
          payload: { subtaskKey: node.id, reason },
          subtaskKey: node.id,
          level: "warn",
        });
      },
    }
    );
  };

  const reviewNodeKeys = reviewNodes.map((node) => node.key);
  const runReviewLoop = async (): Promise<boolean> => {
    if (reviewNodes.length === 0) return true;

    const maxIterations = deps.policy.maxReviewIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      for (const key of reviewNodeKeys) delete state.reviewVerdicts[key];

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "task.stage",
        payload: { stage: "reviewing", iteration, planVersion: plan.version },
      });

      const reviewRun = await runNodes(reviewNodes);
      if (reviewRun.status !== "completed") return false;

      const changesRequested = reviewNodeKeys.some(
        (key) => state.reviewVerdicts[key]?.verdict === "changes_requested"
      );
      if (!changesRequested) {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "review.approved",
          payload: { iteration },
        });
        return true;
      }

      const findings = collectRequestedChanges(state.reviewVerdicts, reviewNodeKeys);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.requested_changes",
        payload: { iteration, findings },
        level: "warn",
      });

      if (iteration >= maxIterations) {
        state.feedback.push(
          `Review still requested changes after ${maxIterations} fix attempt(s): ${findings
            .map((finding) => finding.description)
            .join("; ")}`
        );
        return false;
      }

      const implementer = implementerAgent(plan, input.agents);
      if (!implementer) {
        state.feedback.push("No implementer agent is available to address review findings");
        return false;
      }

      const codeSubtask = plan.subtasks.find((candidate) => candidate.kind === "code_change");
      const fixSubtask = buildReviewFixSubtask({
        iteration: iteration + 1,
        findings,
        capability: codeSubtask?.capability ?? CAPABILITY.GENERAL,
        order: plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1,
      });
      plan.subtasks.push(fixSubtask);
      state.priorOutputs.set(`${fixSubtask.key}-findings`, formatReviewFindings(findings));

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "review.fix_started",
        payload: {
          iteration: iteration + 1,
          findings: findings.length,
          agent: implementer.name,
        },
      });

      const fixRun = await runNodes([fixSubtask]);
      if (fixRun.status !== "completed") {
        state.feedback.push(`Review fix attempt ${iteration + 1} failed`);
        return false;
      }
    }

    return false;
  };

  const implementation = await runNodes(implementationNodes);
  if (implementation.status === "cancelled") {
    await deps.api
      .updateSubtask({
        taskId,
        key: implementationNodes[0]?.key ?? reviewNodes[0]?.key ?? qaNodes[0]?.key ?? "unknown",
        status: "blocked",
      })
      .catch(() => undefined);
    return "failed";
  }
  if (implementation.status !== "completed") {
    return "failed";
  }

  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  if (hasCodeChange && state.fileChanges.size === 0) {
    state.feedback.push("The implementation produced no file changes");
    return "failed";
  }

  const reviewApproved = await runReviewLoop();
  if (!reviewApproved) {
    return "failed";
  }

  const preparedChanges = Array.from(state.fileChanges.values());

  let dryRunSummary:
    | { filePaths: string[]; count: number; changes: string[] }
    | undefined;
  if (preparedChanges.length > 0) {
    const dryRun = await dryRunPolicy(
      preparedChanges,
      deps,
      task,
      project,
      plan,
      plan.version,
      state
    );
    if (!dryRun.allowed) {
      return "failed";
    }
    dryRunSummary = dryRun.summary;
  }

  const shouldAsk =
    input.approvalMode === "ask" &&
    plan.requiresApproval &&
    !input.approvalResolved &&
    preparedChanges.length > 0;

  if (shouldAsk) {
    const implementer = implementerAgent(plan, input.agents);
    const summary = `Apply changes to ${preparedChanges.length} file(s): ${preparedChanges
      .map((change) => change.filePath)
      .join(", ")}`;
    await deps.api.requestApproval({
      taskId,
      projectId: project._id,
      subtaskKey: plan.subtasks.find((subtask) => subtask.kind === "code_change")?.key,
      kind: "apply_changes",
      summary,
      payload: {
        filePaths: preparedChanges.map((change) => change.filePath),
        planVersion: plan.version,
        policyDryRun: dryRunSummary,
      },
      requestedByAgentId: implementer?._id,
      planVersion: plan.version,
    });
    await deps.api.appendAgentMessage({
      projectId: project._id,
      taskId,
      agentId: implementer?._id,
      content: `Changes are prepared and verified. ${summary}. Waiting for your approval before writing them to the workspace.`,
    });
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "waiting_approval", files: preparedChanges.length },
      level: "warn",
    });
    await deps.api.recordAudit({
      taskId,
      projectId: project._id,
      workerId: deps.workerId,
      actor: implementer?.name ?? "orchestrator",
      tool: "apply_changes",
      action: "request",
      decision: "pending",
      target: preparedChanges.map((change) => change.filePath).join(","),
      details: { dryRun: dryRunSummary },
    });
    return "waiting_approval";
  }

  if (preparedChanges.length > 0) {
    const wp = resolveWorkspacePath(deps.workspaceRoot, project.workspacePath);
    const appliedPaths: string[] = [];
    for (const change of preparedChanges) {
      try {
        await applyFileChange(wp, change);
        const verified = await fs.readFile(path.join(wp, change.filePath), "utf-8");
        if (hashContent(verified) !== hashContent(change.newContent ?? "")) {
          throw new Error(`${change.filePath}: content mismatch after apply`);
        }
        appliedPaths.push(change.filePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "fileChanges.apply_failed",
          payload: { message },
          level: "error",
        });
        state.feedback.push(`Apply failed: ${message}`);
        return "failed";
      }
    }
    if (appliedPaths.length > 0) {
      await deps.api.markFilesApplied(taskId, appliedPaths, deps.workerId);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "fileChanges.applied",
        payload: { filePaths: appliedPaths },
      });
      await deps.api.recordAudit({
        taskId,
        projectId: project._id,
        workerId: deps.workerId,
        actor: input.approvalResolved ? "user" : "orchestrator",
        tool: "apply_changes",
        action: "apply",
        decision: "allowed",
        target: appliedPaths.join(","),
        details: { filePaths: appliedPaths, planVersion: plan.version },
      });
      if (input.approvalResolved) {
        await deps.api.appendAgentMessage({
          projectId: project._id,
          taskId,
          content: `Approved changes applied to ${appliedPaths.length} file(s). Running verification.`,
        });
      }
    }
  }

  if (qaNodes.length > 0) {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "verifying", files: preparedChanges.length },
    });
    const qa = await runNodes(qaNodes);
    if (qa.status === "cancelled") {
      return "failed";
    }
    // QA failures are recorded on the subtasks; the evaluator decides the verdict.
  }

  return "completed";
}

export async function resumeTask(taskId: string, deps: RunnerDeps): Promise<void> {
  const context = await deps.api.getContext(taskId);
  if (!context?.project || context.task.status !== "needs_approval") return;
  const approvals = await deps.api.getApprovals(taskId);
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length > 0) return;

  const applyApprovals = approvals.filter((approval) => approval.kind === "apply_changes");
  if (applyApprovals.length === 0) return;

  if (applyApprovals.some((approval) => approval.status === "rejected")) {
    await deps.api.appendAgentMessage({
      projectId: context.project._id,
      taskId,
      content: "Changes were rejected by the user and were not applied to the workspace.",
    });
    await deps.api.recordAudit({
      taskId,
      projectId: context.project._id,
      workerId: deps.workerId,
      actor: "user",
      tool: "apply_changes",
      action: "reject",
      decision: "denied",
    });
    await deps.api.completeTask(taskId, "rejected", "Changes rejected by user");
    return;
  }
  if (!applyApprovals.some((approval) => approval.status === "approved")) return;

  const planValidation = context.plan
    ? validatePlan(context.plan.payload, deps.policy.maxSubtasks)
    : null;
  if (!planValidation?.ok || !planValidation.plan) {
    await deps.api.completeTask(taskId, "failed", "Stored plan is missing or invalid");
    return;
  }
  const plan = planValidation.plan;
  const planVersion = context.plan?.version ?? context.task.planVersion ?? 1;
  const workspacePath = resolveWorkspacePath(deps.workspaceRoot, context.project.workspacePath);
  await fs.mkdir(workspacePath, { recursive: true });

  const changes = await deps.api.getFileChanges(taskId);

  const agents = context.agents.map(toAgentDefinition);
  const completedKeys = new Set(
    context.subtasks
      .filter((subtask) => subtask.status === "completed")
      .map((subtask) => subtask.key)
  );
  const state: RunState = {
    priorOutputs: new Map(
      context.subtasks
        .filter((subtask) => subtask.status === "completed" && subtask.output)
        .map((subtask) => [subtask.key, subtask.output as string])
    ),
    qaVerdicts: {},
    reviewVerdicts: {},
    fileChanges: new Map(
      changes.map((change) => [change.filePath, toFileDiff(change)])
    ),
    feedback: [],
  };

  const outcome = await executePlan({
    deps,
    task: context.task,
    project: context.project,
    workspacePath,
    agents,
    plan,
    state,
    approvalResolved: true,
    approvalMode: context.approvalMode,
    completedKeys,
  });
  if (outcome === "waiting_approval") return;

  const after = await deps.api.getContext(taskId);
  await finalize({
    deps,
    task: context.task,
    project: context.project,
    workspacePath,
    plan,
    planVersion,
    subtasks: after?.subtasks ?? [],
    state,
  });
}

async function mergeApprovalResolved(
  deps: RunnerDeps,
  task: WorkerTask,
  project: WorkerProject,
  branchName?: string,
  worktreePath?: string
): Promise<boolean> {
  let attempt = 0;
  const maxAttempts = 480; // ~12 min at 1.5s interval
  while (attempt < maxAttempts) {
    const approvals = await deps.api.getApprovals(task._id);
    const pending = approvals.filter(
      (a) => a.kind === "merge_pr" && a.status === "pending"
    );
    if (pending.length === 0) {
      const resolved = approvals.find((a) => a.kind === "merge_pr");
      if (resolved?.status === "approved") {
        if (branchName && worktreePath) {
          try {
            await deps.api.mergeBranch({ taskId: task._id });
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "branch.merged",
              payload: { branchName },
              level: "info",
            });
          } catch (err: any) {
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "branch.merge_failed",
              payload: { error: err.message },
              level: "error",
            });
            await deps.api.completeTask(task._id, "failed", `Merge failed: ${err.message}`);
            return false;
          }
        }
        await deps.api.recordAudit({
          taskId: task._id,
          projectId: project._id,
          workerId: deps.workerId,
          actor: "user",
          tool: "merge_pr",
          action: "approve",
          decision: "allowed",
        });
        await deps.api.completeTask(task._id, "done");
        return true;
      } else if (resolved?.status === "rejected") {
        if (branchName && worktreePath) {
          await deps.api.discardBranch({ taskId: task._id });
          await deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "branch.discarded",
            payload: { branchName },
            level: "warn",
          });
        }
        await deps.api.recordAudit({
          taskId: task._id,
          projectId: project._id,
          workerId: deps.workerId,
          actor: "user",
          tool: "merge_pr",
          action: "reject",
          decision: "denied",
        });
        await deps.api.appendAgentMessage({
          projectId: project._id,
          taskId: task._id,
          content: "Changes were rejected by the user. Branch has been discarded.",
        });
        await deps.api.completeTask(task._id, "rejected", "Changes rejected by user");
        return false;
      }
    }
    await sleep(1500);
    attempt++;
  }
  await deps.api.completeTask(task._id, "failed", "Approval timed out");
  return false;
}

async function finalizeRecordEval(
  deps: RunnerDeps,
  input: {
    taskId: string;
    projectId: string;
    planVersion: number;
    evaluation: EvaluationResult;
  }
): Promise<void> {
  await deps.api.recordEvaluation({
    taskId: input.taskId,
    projectId: input.projectId,
    planVersion: input.planVersion,
    verdict: input.evaluation.verdict,
    checks: input.evaluation.checks,
    notes: input.evaluation.notes.join("; ") || undefined,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finalize(input: {
  deps: RunnerDeps;
  task: WorkerTask;
  project: WorkerProject;
  workspacePath: string;
  plan: ExecutionPlan;
  planVersion: number;
  subtasks: WorkerSubtask[];
  state: RunState;
}): Promise<EvaluationResult> {
  const { deps, task, project, planVersion, state, plan } = input;
  const applyApprovals = await deps.api.getApprovals(task._id);
  const hasApprovalPlan = applyApprovals.some(
    (approval) => approval.kind === "apply_changes" && approval.status === "approved"
  );
  const changes = await deps.api.getFileChanges(task._id);

  const appliedChanges = changes.filter((change) => change.appliedAt);
  const hasCodeChange = plan.subtasks.some((subtask) => subtask.kind === "code_change");
  let verificationChecks: EvaluationCheck[] | undefined;

  if (deps.policy.verificationEnabled && hasCodeChange && appliedChanges.length > 0) {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.stage",
      payload: { stage: "static-verification", files: appliedChanges.length },
    });

    const verification = await runVerification({
      workspacePath: input.workspacePath,
      changedFiles: appliedChanges.map((change) => change.filePath),
      includeBuild: deps.policy.verificationIncludeBuild,
      timeoutMs: deps.policy.verificationTimeoutMs,
      onCheck: async (check) => {
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "task.check",
          payload: {
            label: `verify:${check.name}`,
            status: check.status,
            details: check.details,
          },
        });
      },
    });

    verificationChecks = verification.checks;
  }

  const evaluation = await evaluateTask({
    workspacePath: input.workspacePath,
    subtasks: input.subtasks.map((subtask) => ({
      key: subtask.key,
      kind: subtask.kind,
      status: subtask.status,
      error: subtask.error,
    })),
    fileChanges: changes.map((change) => ({
      filePath: change.filePath,
      changeType: change.changeType,
      newContentHash: change.newContentHash,
      newContent: change.newContent,
      appliedAt: change.appliedAt,
    })),
    hasApprovalPlan: hasApprovalPlan || plan.requiresApproval,
    qaVerdicts: state.qaVerdicts,
    verificationChecks,
  });

  await deps.api.recordEvaluation({
    taskId: task._id,
    projectId: project._id,
    planVersion,
    verdict: evaluation.verdict,
    checks: evaluation.checks,
    notes: evaluation.notes.join("; ") || undefined,
  });

  const details = evaluation.checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.name} (${check.status}): ${check.details ?? ""}`)
    .join("; ");

  if (evaluation.verdict === "failed") {
    await deps.api.logEvent({
      taskId: task._id,
      projectId: project._id,
      type: "task.error",
      payload: { message: details || "Evaluation failed" },
      level: "error",
    });
    await deps.api.completeTask(task._id, "failed", details || "Evaluation failed");
    return evaluation;
  }

  const message =
    evaluation.verdict === "inconclusive"
      ? `Task finished, but verification is inconclusive: ${details || "not all checks were performed"}.`
      : "Task completed and verified.";
  await deps.api.appendAgentMessage({
    projectId: project._id,
    taskId: task._id,
    content: message,
  });
  await deps.api.completeTask(task._id, "done");
  return evaluation;
}

async function persistPlan(
  deps: RunnerDeps,
  input: {
    taskId: string;
    projectId: string;
    plan: ExecutionPlan;
    version: number;
    createdBy: "orchestrator" | "fallback";
    classification: string;
  }
): Promise<void> {
  await deps.api.setPlanning({
    taskId: input.taskId,
    classification: input.classification,
    strategy: input.plan.strategy,
    planVersion: input.version,
  });
  await deps.api.savePlan({
    taskId: input.taskId,
    projectId: input.projectId,
    version: input.version,
    strategy: input.plan.strategy,
    createdBy: input.createdBy,
    goal: input.plan.goal,
    payload: input.plan,
    subtasks: input.plan.subtasks,
  });
}

async function dryRunPolicy(
  changes: FileDiff[],
  deps: RunnerDeps,
  task: WorkerTask,
  project: WorkerProject,
  plan: ExecutionPlan,
  planVersion: number,
  state: RunState
): Promise<{ allowed: boolean; summary: { filePaths: string[]; count: number; changes: string[] } }> {
  const normalized = changes.map((change) => normalizeFileChangePath(change.filePath)).filter(Boolean);
  const forbidden = normalized.filter((filePath) => isForbiddenFilePath(filePath));
  const filePaths = changes.map((change) => change.filePath);
  const summary = {
    filePaths,
    count: changes.length,
    changes: changes.map((change) => `${change.changeType}:${change.filePath}`),
  };

  if (forbidden.length > 0) {
    state.feedback.push(`Policy denied protected paths: ${forbidden.join(", ")}`);
    await deps.api.recordAudit({
      taskId: task._id,
      projectId: project._id,
      workerId: deps.workerId,
      actor: "orchestrator",
      tool: "apply_changes",
      action: "dry-run",
      decision: "denied",
      target: forbidden.join(","),
      details: { reason: "file-path-forbidden", planVersion },
    });
    return { allowed: false, summary };
  }

  await deps.api.recordAudit({
    taskId: task._id,
    projectId: project._id,
    workerId: deps.workerId,
    actor: "orchestrator",
    tool: "apply_changes",
    action: "dry-run",
    decision: "allowed",
    target: filePaths.join(","),
    details: { count: changes.length, planVersion },
  });
  await deps.api.logEvent({
    taskId: task._id,
    projectId: project._id,
    type: "task.policy_dry_run",
    payload: { allowed: true, files: changes.length },
  });
  return { allowed: true, summary };
}

function normalizeFileChangePath(filePath: string): string {
  return filePath.replace(/\\\\/g, "/").replace(/^\/+/, "");
}

function isForbiddenFilePath(filePath: string): boolean {
  const normalized = normalizeFileChangePath(filePath).toLowerCase();
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.startsWith(".git/") ||
    normalized.includes("/.git/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/") ||
    normalized === "package-lock.json" ||
    normalized.endsWith("/package-lock.json") ||
    normalized === "pnpm-lock.yaml" ||
    normalized.endsWith("/pnpm-lock.yaml") ||
    normalized === "yarn.lock" ||
    normalized.endsWith("/yarn.lock") ||
    normalized.startsWith(".ssh/") ||
    normalized.includes("/.ssh/")
  );
}

function implementerAgent(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): AgentDefinition | null {
  const codeSubtask = plan.subtasks.find((subtask) => subtask.kind === "code_change");
  if (codeSubtask) return routeCapability(codeSubtask.capability, agents);
  return routeCapability(CAPABILITY.GENERAL, agents);
}

function toFileDiff(change: WorkerFileChange): FileDiff {
  return {
    filePath: change.filePath,
    changeType: change.changeType,
    oldContent: change.oldContent,
    newContent: change.newContent,
    oldContentHash: change.oldContentHash,
    newContentHash: change.newContentHash,
    diff: change.diff,
  };
}

export function toAgentDefinition(agent: WorkerAgent): AgentDefinition {
  return {
    _id: agent._id,
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    llmProvider: agent.llmProvider,
    llmModel: agent.llmModel,
    llmBaseUrl: agent.llmBaseUrl,
    llmApiKey: agent.llmApiKey,
    description: agent.description,
    capabilities: agent.capabilities,
    supportedTools: agent.supportedTools,
    isEnabled: agent.isEnabled,
    priority: agent.priority,
    maxConcurrency: agent.maxConcurrency,
    status: agent.status,
  };
}

export function resolveWorkspacePath(workspaceRoot: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(workspaceRoot, configured);
}

export function heuristicPlanForTest(
  command: string,
  agents: AgentDefinition[]
): ExecutionPlan {
  return heuristicPlan({
    command,
    classification: classifyCommand(command),
    agents,
    policy: {
      maxSubtasks: 8,
      maxConcurrency: 2,
      maxReplans: 1,
      maxReviewIterations: 2,
      subtaskTimeoutMs: 180_000,
      subtaskRetries: 1,
      approvalTimeoutMs: 30 * 60_000,
      taskTimeoutMs: 30 * 60_000,
      verificationEnabled: true,
      verificationIncludeBuild: true,
      verificationTimeoutMs: 180_000,
    },
  });
}

export type { SubtaskKind };
