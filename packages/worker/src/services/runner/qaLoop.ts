import type { RunContext } from "./types";
import type { PlanSubtask } from "@/orchestrator/types";
import { implementerAgent, qaFindings } from "./setup";
import { buildFixSubtask, formatReviewFindings } from "@/orchestrator/reviewLoop";
import { capabilitiesOf } from "@/orchestrator/capabilities";
import { CAPABILITY } from "@/orchestrator/types";
import type { FileDiff } from "@/tools/gitDiff";
import { wantsVisualQa } from "@/orchestrator/planner";

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
    applyStaged,
  } = ctx;
  const runNodes = (nodes: PlanSubtask[]) => ctx.runNodes(nodes);
  if (qaNodes.length === 0) return true;
  ctx.inStageLoop = true;
  try {
    // Resume/recovery: when QA already passed pre-interruption, its
    // verdict is seeded by buildStateFromDb. Re-running it would
    // duplicate the QA messages and burn another full pass, so the
    // stage is satisfied without re-running.
    if (qaNodes.every((node) => state.qaVerdicts[node.key] === "passed")) {
      return true;
    }

    const maxIterations = deps.policy.maxReviewIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      for (const node of qaNodes) {
        delete state.qaVerdicts[node.key];
        // The loop deliberately re-runs its own QA nodes: clear this run's
        // completion mark so the scheduler executes them again.
        runCompleted.delete(node.key);
      }

      const qaRun = await runNodes(qaNodes);
      if (qaRun.status === "cancelled") return false;

      const failedNodes = qaNodes.filter((node) => state.qaVerdicts[node.key] !== "passed");
      if (qaRun.status === "completed" && failedNodes.length === 0) {
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "qa.passed",
          payload: { iteration },
          message: "QA verification passed: all checks and assertions satisfied.",
        });
        const qaAgent =
          agents.find((a) => a.role === "qa") ||
          agents.find((a) => capabilitiesOf(a).includes(CAPABILITY.BROWSER_TESTING));
        if (qaAgent) {
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
            agentId: qaAgent._id as any,
            content: `QA validation passed. ${detail}${
              visualQa
                ? " Visual checks completed as requested."
                : " Structural checks only — no visual comparison."
            }`,
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

      const implementer = implementerAgent(plan, agents);
      if (!implementer) {
        state.feedback.push("No implementer agent is available to address QA failures");
        return false;
      }

      const codeSubtask = plan.subtasks.find((candidate) => candidate.kind === "code_change");
      const fixSubtask = buildFixSubtask({
        key: `fix_qa_${iteration + 1}`,
        title: `Address QA failures (iteration ${iteration + 1})`,
        intro: "QA reported failures on the prepared work.",
        findings,
        capability: codeSubtask?.capability ?? CAPABILITY.GENERAL,
        order: plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1,
      });
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
      // pass. In ask mode the approval gate stays authoritative: the
      // fix is applied only after the user approved the plan's changes
      // (the main apply phase above), never silently on its own.
      if (input.approvalMode !== "ask") {
        const fixPaths = state.appliedFilesBySubtask.get(fixSubtask.key) ?? [];
        const fixChanges = fixPaths
          .map((filePath) => state.fileChanges.get(filePath))
          .filter((change): change is FileDiff => Boolean(change));
        const applied = await applyStaged(fixChanges, "orchestrator");
        if ("stop" in applied) {
          state.feedback.push(`QA fix attempt ${iteration + 1} could not be applied`);
          return false;
        }
      }
    }

    return false;
  } finally {
    ctx.inStageLoop = false;
  }
}
