import type { RunContext } from "./types";
import type { PlanSubtask } from "@/orchestrator/types";
import { qaFindings } from "./setup";
import { buildFixSubtask, formatReviewFindings } from "@/orchestrator/reviewLoop";
import { capabilitiesOf, normalizeCapability, routeCapability } from "@/orchestrator/capabilities";
import { CAPABILITY } from "@/orchestrator/types";
import { wantsVisualQa } from "@/orchestrator/planner";
import { pickFixOwner, type FixCandidate } from "@/orchestrator/ownership";
import { applyOrRequestFixApproval } from "./fixApply";

/**
 * Fix owner for QA findings: QA exercises the UI, so the UI owner
 * (a frontend/design code_change) is preferred; otherwise the shared
 * pickFixOwner (longest allowedPaths prefix, last code_change).
 */
export function pickQaFixOwner(
  subtasks: FixCandidate[],
  findings: Array<{ filePath?: string }>
): FixCandidate | undefined {
  const uiCapabilities = new Set<string>([CAPABILITY.FRONTEND, CAPABILITY.DESIGN]);
  const uiOwners = subtasks.filter(
    (s) => s.kind === "code_change" && uiCapabilities.has(normalizeCapability(s.capability))
  );
  if (uiOwners.length > 0) return pickFixOwner(uiOwners, findings);
  return pickFixOwner(subtasks, findings);
}

/**
 * The QA correction loop (plan 012 step 2): a failing QA verdict spawns a
 * fix subtask carrying the QA failure as findings, applies its staged files,
 * and the same QA nodes re-run — bounded by maxReviewIterations. Extracted
 * verbatim from executePlan; state that used to be captured is threaded
 * through `ctx`.
 *
 * Loop ownership: while this loop runs (including its fix subtasks), the
 * objective is not judgeable — same rule as the review loop.
 */
export async function runQaLoop(ctx: RunContext): Promise<boolean> {
  const {
    qaNodes,
    plan,
    state,
    runCompleted,
    dynamicKeys,
    chainByKey,
    fixDepthByKey,
    persistDynamic,
    deps,
    input,
    taskId,
    project,
    agents,
  } = ctx;
  const qaAgent = () =>
    agents.find((a) => a.role === "qa") ||
    agents.find((a) => capabilitiesOf(a).includes(CAPABILITY.BROWSER_TESTING));
  const runNodes = (nodes: PlanSubtask[]) => ctx.runNodes(nodes);
  if (qaNodes.length === 0) return true;
  /** One clear QA-skipped note; fails only when QA is required. */
  const reportBlocked = async (reason: string): Promise<boolean> => {
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "qa.blocked",
      payload: { reason, required: deps.policy.qaRequired === true },
      message: `QA skipped: ${reason}`,
      level: "warn",
    });
    await deps.api.appendAgentMessage({
      projectId: project._id,
      taskId,
      agentId: qaAgent()?._id as any,
      content: `QA skipped: ${reason}. No browser checks ran${
        deps.policy.qaRequired
          ? " and QA is required (QA_REQUIRED), so the task cannot complete."
          : "; this is a setup/scope note, not a code defect."
      }`,
    });
    if (deps.policy.qaRequired) {
      state.feedback.push(`QA required but blocked: ${reason}`);
      return false;
    }
    return true;
  };
  ctx.inStageLoop = true;
  try {
    // Resume/recovery: when QA already passed pre-interruption, its
    // verdict is seeded by buildStateFromDb. Re-running it would
    // duplicate the QA messages and burn another full pass, so the
    // stage is satisfied without re-running.
    if (qaNodes.every((node) => state.qaVerdicts[node.key] === "passed")) {
      return true;
    }

    // Runtime gates (QA policy §5): QA runs only on APPLIED changes in a
    // browser-runnable project. Otherwise it is skipped with a clear note
    // (verdict "blocked"), never a fix loop and never a failed task unless
    // qaRequired.
    // (Browser-runnability is checked by the QA executor itself, which
    // reports a non-runnable project as a "blocked" verdict.)
    const skipReason =
      state.fileChanges.size === 0
        ? "no code changes were applied, so there is nothing new to check in the browser"
        : null;
    if (skipReason) {
      for (const node of qaNodes) {
        state.qaVerdicts[node.key] = "blocked";
        state.qaChecks = {
          ...(state.qaChecks ?? {}),
          [node.key]: [{ label: "qa-environment", status: "inconclusive", details: skipReason }],
        };
        runCompleted.add(node.key);
        await deps.api
          .updateSubtask({
            taskId,
            key: node.key,
            status: "completed",
            output: `QA verdict: blocked — QA skipped: ${skipReason}.`,
          })
          .catch(() => undefined);
      }
      return await reportBlocked(skipReason);
    }

    // QA has its own (smaller) fix budget: at most 1 automatic round by default.
    const maxIterations = deps.policy.qaMaxFixIterations ?? deps.policy.maxReviewIterations;
    // A resumed run (after an ask-mode fix approval) continues the count,
    // so the bound holds across pauses and fix keys never collide.
    const priorFixes = plan.subtasks.filter((c) => c.key.startsWith("fix_qa_")).length;

    for (let iteration = priorFixes; iteration <= maxIterations; iteration += 1) {
      for (const node of qaNodes) {
        delete state.qaVerdicts[node.key];
        // The loop deliberately re-runs its own QA nodes: clear this run's
        // completion mark so the scheduler executes them again.
        runCompleted.delete(node.key);
      }

      const qaRun = await runNodes(qaNodes);
      if (qaRun.status === "cancelled") return false;

      // Environment-blocked QA (no browser / deps / dev script) is not a
      // code defect: report it once, never route it to a fix.
      const blockedNodes = qaNodes.filter((node) => state.qaVerdicts[node.key] === "blocked");
      const failedNodes = qaNodes.filter(
        (node) => state.qaVerdicts[node.key] !== "passed" && state.qaVerdicts[node.key] !== "blocked"
      );
      if (blockedNodes.length > 0 && failedNodes.length === 0) {
        const reason =
          blockedNodes
            .flatMap((node) => state.qaChecks?.[node.key] ?? [])
            .find((check) => check.label === "qa-environment")?.details ??
          "the QA environment could not run browser checks";
        return await reportBlocked(reason);
      }
      if (qaRun.status === "completed" && failedNodes.length === 0) {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "qa.passed",
          payload: { iteration },
          message: "QA passed: the executed browser checks succeeded.",
        });
        const qaAgentDef = qaAgent();
        if (qaAgentDef) {
          // Describe what actually ran, not a boilerplate list: the URL
          // that was checked and the checks that executed. The plan-level
          // intent is authoritative (a prohibition like "no screenshots"
          // must never be read as a request for visual checks just
          // because the word appears). No @QA mention here: the message
          // is authored by the QA agent itself, so a leading self-tag
          // reads as QA talking about itself.
          const visualQa = plan.visualQa ?? wantsVisualQa(input.task.command);
          const ranChecks = qaNodes.flatMap((node) => state.qaChecks?.[node.key] ?? []);
          const passedCount = ranChecks.filter((check) => check.status === "passed").length;
          const baselineOnly = ranChecks.some((check) => /baseline created/i.test(check.details ?? ""));
          // Same source as executeQa: the resolved URL recorded in the
          // "application reachable" check (the threaded qaBaseUrl may be
          // unset when the project has no qaUrl/devUrl configured).
          const checked =
            ranChecks.find((check) => check.label === "application reachable")?.details ??
            input.qaBaseUrl ??
            "the app";
          const detail =
            ranChecks.length > 0
              ? `Checked ${checked} — ${passedCount}/${ranChecks.length} checks ok: ${ranChecks
                  .map((check) => check.label)
                  .join(", ")}.`
              : "";
          await deps.api.appendAgentMessage({
            projectId: project._id,
            taskId,
            agentId: qaAgentDef._id as any,
            content: `QA checks passed. ${detail}${
              visualQa
                ? baselineOnly
                  ? " Visual baseline created, no comparison yet (first visual run)."
                  : " Screenshots compared against the previous baseline."
                : " Structural checks only — no visual comparison."
            } Task-specific behaviour was not asserted automatically.`,
          });
        }
        return true;
      }

      if (qaRun.status !== "completed" && failedNodes.length === 0) {
        return false;
      }

      // Synthesize findings from the QA checks/failures on the outcomes.
      const findings = qaFindings(qaRun, failedNodes);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "qa.failed",
        payload: { iteration, findings },
        message: `QA reported ${findings.length} issue(s) requiring revision.`,
        level: "warn",
      });

      if (iteration >= maxIterations) {
        state.feedback.push(
          `QA still failing after ${maxIterations} fix attempt(s): ${findings
            .map((finding) => finding.description)
            .join("; ")}`
        );
        return false;
      }

      const owner = pickQaFixOwner(plan.subtasks, findings);
      const fixCapability = owner?.capability ?? CAPABILITY.GENERAL;
      // Log/route the agent that will ACTUALLY serve the fix capability.
      const implementer = routeCapability(fixCapability, agents);
      if (!implementer) {
        state.feedback.push("No implementer agent is available to address QA failures");
        return false;
      }

      const fixSubtask = {
        ...buildFixSubtask({
          key: ctx.uniqueSubtaskKey(`fix_qa_${iteration + 1}`),
          title: `Address QA failures (iteration ${iteration + 1})`,
          intro: "QA reported failures on the prepared work.",
          findings,
          capability: fixCapability,
          order: plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1,
        }),
        // Scope the fix to the owner's files (QA findings carry no path).
        ...(owner?.allowedPaths && owner.allowedPaths.length > 0
          ? { allowedPaths: [...owner.allowedPaths] }
          : {}),
      };
      plan.subtasks.push(fixSubtask);
      dynamicKeys.add(fixSubtask.key);
      // The QA loop owns this fix: register it as a fix-depth-1 node on its
      // own chain so an orchestrator evaluation of its outcome can never
      // spawn a second, duplicate fix subtask (mirrors the review loop).
      chainByKey.set(fixSubtask.key, [fixSubtask.capability]);
      fixDepthByKey.set(fixSubtask.key, 1);
      await persistDynamic([fixSubtask], "fix");
      state.priorOutputs.set(`${fixSubtask.key}-findings`, formatReviewFindings(findings));

      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "qa.fix_started",
        payload: {
          iteration: iteration + 1,
          findings: findings.length,
          agent: implementer.name,
        },
        level: "warn",
      });

      const fixRun = await runNodes([fixSubtask]);
      if (fixRun.status !== "completed") {
        state.feedback.push(`QA fix attempt ${iteration + 1} failed`);
        return false;
      }
      // The fix's staged changes must reach the workspace before QA
      // re-runs, otherwise QA validates the pre-fix app and can never
      // pass. In ask mode the fix is NOT silently applied: an approval is
      // requested and the task pauses (QA audit P0-4).
      const landed = await applyOrRequestFixApproval(ctx, fixSubtask, "QA");
      if (landed === "waiting_approval") return false;
      if (landed === "failed") {
        state.feedback.push(`QA fix attempt ${iteration + 1} could not be applied`);
        return false;
      }
    }

    return false;
  } finally {
    ctx.inStageLoop = false;
  }
}
