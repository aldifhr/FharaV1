import type { RunContext, RunState } from "./types";
import type { SchedulerNode, NodeOutcome } from "@/scheduler/dagScheduler";
import type { PlanSubtask } from "@/orchestrator/types";
import type { ReviewResult } from "@/utils/json";
import { evaluateAfterExecution } from "@/orchestrator/orchestrator";
import {
  decide,
  applyDecision,
  evaluateObjective,
  type DecisionContext,
  type DecisionObservation,
} from "@/orchestrator/decision";
import { decideWithLlm } from "@/orchestrator/decisionLlm";
import { buildFixSubtask } from "@/orchestrator/reviewLoop";
import { kindForCapability, slugifyKeyPart, toAgentResult } from "./setup";

/**
 * Plan 012 Step 3: the scheduler's `onOutcome` handler, extracted verbatim
 * from `executePlan`. Evaluates every finished subtask, keeps the shared
 * context current, and (authoritative mode) acts on the decision: APPROVE
 * spawns a delegation subtask, REVISE spawns a fix subtask, BLOCKED halts
 * scheduling. Any orchestrator failure is logged, never propagated.
 *
 * Returns the dynamic nodes the scheduler should add to this invocation, or
 * undefined when the decision spawned none.
 */
export async function handleNodeOutcome(
  ctx: RunContext,
  node: SchedulerNode,
  outcome: NodeOutcome,
  attempt: number
): Promise<SchedulerNode[] | undefined> {
  const {
    agentByKey,
    executionIds,
    runCompleted,
    activeByAgent,
    chainByKey,
    fixDepthByKey,
    dynamicKeys,
    plan,
    state,
    deps,
    task,
    project,
    input,
    taskId,
    uniqueSubtaskKey,
    nextOrder,
    persistDynamic,
    plannedCapabilities,
    budgetEnforced,
    authoritative,
    decisionEngine,
  } = ctx;

  const agent = agentByKey.get(node.id);
  const executionId = executionIds.get(node.id);
  // The node has settled: it no longer counts as active work for
  // its agent (a scheduler retry re-enters via onStart).
  if (agent && !runCompleted.has(node.id)) {
    activeByAgent.set(
      agent._id,
      Math.max(0, (activeByAgent.get(agent._id) ?? 1) - 1)
    );
  }
  let dynamicNodes: SchedulerNode[] | undefined;
  if (!runCompleted.has(node.id) && executionId) {
    await deps.api.updateExecution({
      executionId,
      subtaskKey: node.id,
      status: outcome.status === "completed" ? "completed" : "failed",
      output: outcome.status === "failed" ? undefined : outcome.output,
      error: outcome.status === "failed" ? outcome.error : undefined,
      meta: outcome.status === "failed" ? undefined : outcome.meta,
    });
  }
  // A node that settles completed joins this run's completion set
  // BEFORE the decision engine reads it below, so a finished node is
  // never treated as pending work.
  if (outcome.status === "completed") runCompleted.add(node.id);
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
    // Keep the actual checks so the pass message can name the URL
    // and the checks that ran instead of a generic template.
    const checks = (meta as { checks?: unknown })?.checks;
    if (Array.isArray(checks)) {
      state.qaChecks = {
        ...(state.qaChecks ?? {}),
        [node.id]: checks as NonNullable<RunState["qaChecks"]>[string],
      };
    }
  }
  // Issue lifecycle (plan 013 step 2): an approving review or a
  // passing planned QA resolves open issues whose related work is
  // actually covered by completed, attributed file changes. Applied
  // BEFORE the decision block re-assigns sharedContext.outstandingIssues
  // (its merge preserves resolutions) so the objective evaluation
  // below no longer reads freshly-fixed findings as open blockers.
  if (outcome.status === "completed" && input.sharedContext) {
    const approvedFiles = new Set(
      [...state.appliedFilesBySubtask.entries()]
        .filter(([key]) => runCompleted.has(key) || key === node.id)
        .flatMap(([, files]) => files)
    );
    if (subtaskKind === "review" && meta?.verdict === "approved") {
      input.sharedContext.outstandingIssues = resolveIssuesForApproval(
        input.sharedContext.outstandingIssues,
        { approvedFiles, approvingAgent: agent?.name }
      );
    }
    if (subtaskKind === "qa" && meta?.verdict === "passed") {
      input.sharedContext.outstandingIssues = resolveIssuesForQaPass(
        input.sharedContext.outstandingIssues,
        approvedFiles
      );
    }
  }
  // Intelligent orchestrator: evaluate every finished subtask, keep
  // the shared context current for the agents that run next, and
  // persist the decision trail. In authoritative mode (Phase 3) the
  // decision is also ACTED on inside this scheduler invocation:
  // APPROVE with an agent recommendation spawns a real delegation
  // subtask, REVISE with structured findings spawns a fix subtask,
  // and BLOCKED (budget) halts new scheduling. With the flag off
  // the behavior is the legacy record-only one. Any orchestrator
  // failure is logged, never propagated.
  if (input.budget && input.sharedContext && input.classification && agent) {
    try {
      const subtaskDef = plan.subtasks.find((candidate) => candidate.key === node.id);
      if (subtaskDef && decisionEngine) {
        const agentResult = toAgentResult({ subtask: subtaskDef, agent, outcome });
        const chain = chainByKey.get(node.id) ?? [subtaskDef.capability];
        // The engine consumes the LIVE evaluation (the same verdict
        // the legacy path records) as its observation, so Phase 2's
        // deterministic mapping is observable without a second gate.
        const live = evaluateAfterExecution({
          result: agentResult,
          classification: input.classification,
          agents: input.agents,
          budget: input.budget,
          previousAgents: input.sharedContext.agentExecutions.map(
            (entry) => entry.agentName
          ),
          delegationDepth: Math.max(0, chain.length - 1),
          alreadyDelegated: chain.slice(0, -1),
          chainCapabilities: chain,
          activeByAgent,
          plannedCapabilities,
          taskContext: input.sharedContext,
          proposer: agent,
        });
        input.sharedContext.decisions = live.updatedContext.decisions;
        input.sharedContext.artifacts = live.updatedContext.artifacts;
        input.sharedContext.outstandingIssues = live.updatedContext.outstandingIssues;
        input.sharedContext.agentExecutions = live.updatedContext.agentExecutions;

        const observation: DecisionObservation = {
          outcome: outcome.status === "completed" ? "completed" : "failed",
          decision: live.decision,
          nextAgent: live.nextAgent,
          nextCapability: live.nextCapability,
          reason: live.reason,
          findings: agentResult.findings,
          delegationRecommendation: agentResult.delegationRecommendation,
          error: outcome.status === "failed" ? outcome.error : undefined,
          retryable: false,
        };

        const decisionContext: DecisionContext = {
          taskId,
          objective: input.sharedContext.objective,
          classification: input.classification,
          planVersion: input.planVersion ?? plan.version,
          plan,
          results: input.sharedContext.agentExecutions,
          openIssues: input.sharedContext.outstandingIssues,
          budget: input.budget.snapshot(),
          policy: deps.policy,
          agents: input.agents,
          completedKeys: runCompleted,
          step: ctx.decisionStep,
          chainCapabilities: chain,
          activeByAgent,
        };
        const { decision: decided, fallback } = await decide(
          decisionContext,
          observation,
          {
            llmMode: deps.policy.decisionLlmMode,
            advise: (ctx, obs) =>
              decideWithLlm({
                ctx,
                observation: obs,
                llmResolver: input.llmResolver,
                llmConfig: input.llmConfig,
                llmTaskGate: input.llmTaskGate,
                onTokenUsage: input.onTokenUsage,
                signal: input.taskAbort?.signal,
                assertBudgetForCall: () => input.budget!.assertLlmCallAllowed(),
              }),
          }
        );
        // Plan 005 Step 5.4: the step bound is terminal — fail the
        // task explicitly, never silently mark it done. `decide`
        // already returned the `decision:step_limit` outcome; latch
        // the halt so the scheduler drains instead of starting more.
        if (decided.expectedOutcome === "decision:step_limit") {
          ctx.stepLimitHit = true;
          await deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "orchestrator.decision",
            payload: {
              subtaskKey: node.id,
              id: decided.id,
              action: decided.action,
              reasoning: decided.reasoning.slice(0, 500),
              target: null,
              decidedBy: decided.decidedBy,
              planVersion: decided.planVersion,
              step: ctx.decisionStep,
              expectedOutcome: decided.expectedOutcome,
            },
            executionId,
            subtaskKey: node.id,
            level: "warn",
          });
          return dynamicNodes;
        }
        // Plan 005 Step 5.1: `complete` is only emitted when the
        // objective evidence says it is met; otherwise the request
        // becomes replan (concrete gaps) or ask_user (no path).
        //
        // Only a node that EXECUTED in this run may be downgraded.
        // A node skipped as "Previously completed" on resume /
        // recovery has no executionId this run; evaluating its
        // objective here compares against rebuilt in-memory
        // evidence, which is incomplete for that node, so the
        // downgrade would fabricate a replan and post a
        // "stopping this step" message per skipped node. The
        // previous run already decided these nodes.
        let decision = decided;
        // A downgrade is internal bookkeeping: the evidence check
        // reclassified this outcome (complete -> replan/ask_user)
        // because the objective is not met *yet* — e.g. a review
        // finding the review loop is already fixing. Narrating it
        // as a CTO "stopping this step" message per node settle is
        // pure spam (the user saw it 5x in one task while the fix
        // loop was progressing normally). Skip the chat narration
        // for downgrades; the objective_unmet event above keeps
        // the telemetry.
        //
        // While a review or QA loop is in flight its open findings
        // are EXPECTED (the loop owns them and will close them when
        // its verdict lands), so the downgrade itself is deferred
        // too: mid-loop downgrades replan the task mid-fix and burn
        // the replans budget for no reason.
        const reviewQaInFlight = plan.subtasks.some(
          (candidate) =>
            (candidate.kind === "review" || candidate.kind === "qa") &&
            !dynamicKeys.has(candidate.key) &&
            !runCompleted.has(candidate.key)
        );
        let downgradedByObjective = false;
        if (decision.action === "complete" && executionId && !reviewQaInFlight) {
          const pendingRequiredNodes = plan.subtasks.some(
             (candidate) =>
               (candidate.kind === "qa" || candidate.kind === "review") &&
               !dynamicKeys.has(candidate.key) &&
               !runCompleted.has(candidate.key) &&
               candidate.key !== node.id
           );
           if (pendingRequiredNodes) return dynamicNodes;
           const objective = evaluateObjective({
            ...decisionContext,
            dynamicKeys,
            objectiveEvidence: {
              appliedFiles: Object.fromEntries(state.appliedFilesBySubtask),
              qaVerdicts: state.qaVerdicts,
              verification: state.verification,
              lastDecision: {
                action: decision.action,
                expectedOutcome: decision.expectedOutcome,
              },
            },
          });
          if (objective.satisfied) {
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "orchestrator.completed",
              payload: {
                evidence: objective.evidence,
                rationale: decision.reasoning.slice(0, 500),
              },
              executionId,
              subtaskKey: node.id,
              level: "info",
            });
          } else {
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "orchestrator.objective_unmet",
              payload: {
                missing: objective.missing,
                evidence: objective.evidence,
              },
              executionId,
              subtaskKey: node.id,
              level: "warn",
            });
            decision = {
              ...decision,
              action: objective.missing.length > 0 ? "replan" : "ask_user",
              reasoning: `objective not satisfied: ${objective.missing.join("; ")}`.slice(0, 500),
              expectedOutcome: "recovery",
            };
            downgradedByObjective = true;
          }
        }
        if (fallback) {
          await deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "orchestrator.decision_fallback",
            payload: { subtaskKey: node.id, reason: fallback.slice(0, 500) },
            executionId,
            subtaskKey: node.id,
            level: "warn",
          });
        }
        await deps.api.logEvent({
          taskId: task._id,
          projectId: project._id,
          type: "orchestrator.decision",
          payload: {
            subtaskKey: node.id,
            id: decision.id,
            action: decision.action,
            reasoning: decision.reasoning.slice(0, 500),
            target: decision.target ?? null,
            decidedBy: decision.decidedBy,
            planVersion: decision.planVersion,
            step: ctx.decisionStep,
            expectedOutcome: decision.expectedOutcome ?? null,
          },
          executionId,
          subtaskKey: node.id,
          level: "info",
        });
        // Step 4.2: the engine's decision joins the shared trail so
        // replan feedback and the persisted context see it. The
        // evaluation-layer entry from evaluateAfterExecution is kept
        // (the UI and legacy readers consume it).
        input.sharedContext.decisions = [
          ...input.sharedContext.decisions,
          {
            decision: decision.action,
            reason: decision.reasoning,
            capability: decision.target?.capability,
            fromAgent: agent.name,
            createdAt: decision.createdAt,
            id: decision.id,
            target: decision.target,
            decidedBy: decision.decidedBy,
            planVersion: decision.planVersion,
            step: ctx.decisionStep,
          },
        ];
        if (decision.action === "delegate" && budgetEnforced) {
          // Count the delegation so the count gate stays honest; the
          // depth/circularity gates were already checked in validate.
          // (Delegation counting is budget bookkeeping only.)
          input.budget.incrementDelegation();
        }
        // Decision narration stays in events only: the chat gets
        // ONE CTO summary at completion. A "Please handle X" /
        // "Please revise" chat line per decision was the remaining
        // spam source (the delegation/revise itself, via applyDecision,
        // is unaffected).
        const applied = applyDecision(
          {
            taskId,
            objective: input.sharedContext.objective,
            classification: input.classification,
            planVersion: input.planVersion ?? plan.version,
            plan,
            results: input.sharedContext.agentExecutions,
            openIssues: input.sharedContext.outstandingIssues,
            budget: input.budget.snapshot(),
            policy: deps.policy,
            agents: input.agents,
            completedKeys: runCompleted,
            step: ctx.decisionStep,
            chainCapabilities: chain,
            activeByAgent,
          },
          decision,
          (base) => uniqueSubtaskKey(`${base}_${ctx.decisionStep}`)
        );
        // Plan 013 step 3: the applied outcome is a discriminated
        // union (see OrchestratorDecision/applied). `nodes` spawns
        // dynamic subtasks; `halt` is a budget BLOCKED and latches the
        // halt like the legacy path; `complete`/`replan`/`ask_user`
        // latch only in the shipped runner (replan needs a return
        // channel beyond this handler), so here they are recorded —
        // same behavior as before the discriminated outcome.
        switch (applied.kind) {
          case "nodes": {
            if (applied.nodes.length > 0) {
              for (const dynamic of applied.nodes) {
                plan.subtasks.push(dynamic);
                dynamicKeys.add(dynamic.key);
                chainByKey.set(dynamic.key, [...chain, dynamic.capability]);
                fixDepthByKey.set(dynamic.key, 0);
              }
              await persistDynamic(applied.nodes, decision.action === "execute" ? "fix" : "delegation");
              dynamicNodes = applied.nodes.map((dynamic) => ({
                id: dynamic.key,
                dependencies: dynamic.dependencies,
              }));
            }
            break;
          }
          case "halt": {
            if (!ctx.budgetHalt) {
              ctx.budgetHalt = true;
              await deps.api.logEvent({
                taskId: task._id,
                projectId: project._id,
                type: "orchestrator.budget_blocked",
                payload: {
                  subtaskKey: node.id,
                  reason: applied.reason.slice(0, 500),
                  budget: input.budget.snapshot(),
                },
                executionId,
                subtaskKey: node.id,
                level: "warn",
              });
            }
            break;
          }
          case "complete":
          case "replan":
          case "ask_user":
            break;
        }
        ctx.decisionStep += 1;
        await deps.api
          .upsertTaskContext?.({
            taskId,
            projectId: project._id,
            originalRequest: input.sharedContext.originalRequest,
            objective: input.sharedContext.objective,
            status: (task.status as any) || "running",
            decisions: input.sharedContext.decisions,
            artifacts: input.sharedContext.artifacts,
            outstandingIssues: input.sharedContext.outstandingIssues,
            budgetSnapshot: input.budget.snapshot(),
          })
          ?.catch(() => undefined);
        return dynamicNodes;
      }
      if (subtaskDef && !decisionEngine) {
        const agentResult = toAgentResult({ subtask: subtaskDef, agent, outcome });
        const chain = chainByKey.get(node.id) ?? [subtaskDef.capability];
        const evaluation = evaluateAfterExecution({
          result: agentResult,
          classification: input.classification,
          agents: input.agents,
          budget: input.budget,
          previousAgents: input.sharedContext.agentExecutions.map(
            (entry) => entry.agentName
          ),
          delegationDepth: Math.max(0, chain.length - 1),
          alreadyDelegated: chain.slice(0, -1),
          chainCapabilities: chain,
          activeByAgent,
          plannedCapabilities,
          taskContext: input.sharedContext,
          proposer: agent,
        });
        input.sharedContext.decisions = evaluation.updatedContext.decisions;
        input.sharedContext.artifacts = evaluation.updatedContext.artifacts;
        input.sharedContext.outstandingIssues =
          evaluation.updatedContext.outstandingIssues;
        input.sharedContext.agentExecutions =
          evaluation.updatedContext.agentExecutions;

        // --- Decision -> action (authoritative mode only) --------
        // Cancellation gates decisions too (Phase 4 hardening):
        // once the task is cancelled/timed out, an outcome that
        // settles late is recorded but spawns NO new work.
        let delegatedSubtaskKey: string | null = null;
        let fixSubtaskKey: string | null = null;
        if (authoritative && !input.taskAbort?.signal.aborted) {
          if (evaluation.decision === "BLOCKED") {
            // Budget exhausted. Enforce mode: stop scheduling new
            // work in this invocation (the scheduler blocks what
            // is still pending once running nodes drain) and mark
            // the task with an explicit budget event; the next
            // LLM call attempt then throws BudgetExhaustedError
            // at the pre-call gate, and the runner's budget
            // ending closes the task with completed outputs
            // preserved. Warn mode (Phase 5 default): the
            // evaluation stays a recorded decision only — no
            // halt, no event here; the pre-call gate's
            // budget.warning is the signal and the run continues.
            if (budgetEnforced && !ctx.budgetHalt) {
              ctx.budgetHalt = true;
              await deps.api.logEvent({
                taskId,
                projectId: project._id,
                type: "orchestrator.budget_blocked",
                payload: {
                  subtaskKey: node.id,
                  reason: evaluation.reason.slice(0, 500),
                  budget: input.budget.snapshot(),
                },
                executionId,
                subtaskKey: node.id,
                level: "warn",
              });
            }
          } else if (
            evaluation.decision === "APPROVE" &&
            evaluation.nextAgent &&
            evaluation.nextCapability &&
            outcome.status === "completed" &&
            agentResult.delegationRecommendation?.targetCapability ===
              evaluation.nextCapability
          ) {
            // Only recommendation-driven approvals spawn work: the
            // agent explicitly asked for another capability. (The
            // deterministic QA heuristic stays a recorded decision —
            // the plan's own QA subtask already covers it, and a
            // second QA node mid-implementation would test code
            // that has not been applied yet.)
            ctx.delegationSeq += 1;
            const key = uniqueSubtaskKey(
              `delegate_${slugifyKeyPart(evaluation.nextCapability)}_${ctx.delegationSeq}`
            );
            const delegationSubtask: PlanSubtask = {
              key,
              title: `Delegated work: ${evaluation.nextCapability}`,
              description: [
                `Delegated by agent ${agent.name} after completing subtask "${subtaskDef.title}" (${subtaskDef.key}).`,
                `Reason: ${agentResult.delegationRecommendation.reason}`,
                `Task goal: ${plan.goal}`,
                "Use the shared task context (previous results, decisions and open issues) and do only the work this capability is responsible for.",
              ].join("\n"),
              kind: kindForCapability(evaluation.nextCapability),
              capability: evaluation.nextCapability,
              dependencies: [node.id],
              order: nextOrder(),
            };
            plan.subtasks.push(delegationSubtask);
            dynamicKeys.add(key);
            chainByKey.set(key, [...chain, evaluation.nextCapability]);
            fixDepthByKey.set(key, 0);
            delegatedSubtaskKey = key;
            await persistDynamic([delegationSubtask], "delegation");
            dynamicNodes = [{ id: key, dependencies: [node.id] }];
          } else if (
            evaluation.decision === "REVISE" &&
            outcome.status === "completed" &&
            subtaskDef.kind !== "review" &&
            (fixDepthByKey.get(node.id) ?? 0) < 1 &&
            agentResult.findings &&
            agentResult.findings.length > 0 &&
            evaluation.nextCapability
          ) {
            // REVISE for a review subtask is owned by the review
            // loop (it builds its own fix subtasks) — spawning one
            // here too would double the fix work, so review kinds
            // never reach this branch. Fix subtasks themselves
            // (fixDepth 1) do not spawn further fixes.
            ctx.fixSeq += 1;
            const key = uniqueSubtaskKey(
              `fix_${slugifyKeyPart(node.id)}_${ctx.fixSeq}`
            );
            const fixSubtask = buildFixSubtask({
              key,
              title: `Address findings from "${subtaskDef.title}"`,
              intro: `The orchestrator evaluated subtask "${subtaskDef.title}" (${subtaskDef.key}) and requested changes.`,
              findings: agentResult.findings,
              capability: evaluation.nextCapability,
              order: nextOrder(),
              dependencies: [node.id],
            });
            plan.subtasks.push(fixSubtask);
            dynamicKeys.add(key);
            chainByKey.set(key, chain);
            fixDepthByKey.set(key, (fixDepthByKey.get(node.id) ?? 0) + 1);
            fixSubtaskKey = key;
            await persistDynamic([fixSubtask], "fix");
            dynamicNodes = [{ id: key, dependencies: [node.id] }];
          }
        }

        if (evaluation.decision === "APPROVE" && evaluation.nextAgent) {
          input.budget.incrementDelegation();
          await deps.api
            .recordDelegation?.({
              taskId,
              projectId: project._id,
              fromAgentId: agent._id,
              toAgentId: evaluation.nextAgent._id,
              decision: "APPROVE",
              reason: evaluation.reason,
              capability: evaluation.nextCapability,
            })
            ?.catch(() => undefined);
          // Plan 006 Phase 4: delegation proposals write the addressed
          // message row so the target agent sees the handoff.
          await deps.api
            .appendAgentMessage({
              projectId: project._id,
              taskId: task._id as any,
              // Keep the handoff visible in the shared chat as a CTO/lead
              // instruction. The delegated agent's executor will follow
              // with its own progress/result message.
              agentId: agent._id as any,
              content: `@${evaluation.nextAgent.name} ${evaluation.reason.slice(0, 300)}`,
              subtaskKey: delegatedSubtaskKey ?? node.id,
              executionId,
            })
            .catch(() => undefined);
        }
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "orchestrator.evaluation",
          payload: {
            subtaskKey: node.id,
            decision: evaluation.decision,
            reason: evaluation.reason.slice(0, 500),
            nextAgent: evaluation.nextAgent?.name ?? null,
            nextCapability: evaluation.nextCapability ?? null,
            delegatedSubtaskKey,
            fixSubtaskKey,
          },
          executionId,
          subtaskKey: node.id,
          level: evaluation.decision === "BLOCKED" ? "warn" : "info",
        });
        // Step 4.2: one decision trail — the legacy path also
        // records `orchestrator.decision` (the evaluation event above
        // stays for the UI). Same vocabulary mapping as
        // nextDeterministicDecision.
        const legacyAction =
          evaluation.decision === "APPROVE"
            ? "delegate"
            : evaluation.decision === "REVISE"
              ? "execute"
              : "complete";
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "orchestrator.decision",
          payload: {
            subtaskKey: node.id,
            id: `eval_${node.id}`,
            action: legacyAction,
            reasoning: evaluation.reason.slice(0, 500),
            target: evaluation.nextCapability
              ? { agentId: evaluation.nextAgent?._id, capability: evaluation.nextCapability }
              : null,
            decidedBy: "deterministic",
            planVersion: input.planVersion ?? plan.version,
            step: null,
            expectedOutcome:
              evaluation.decision === "BLOCKED"
                ? "policy:budget"
                : evaluation.decision === "REJECT"
                  ? "proposal:rejected"
                  : legacyAction === "delegate"
                    ? "delegated"
                    : legacyAction === "execute"
                      ? "fixed"
                      : "objective:met",
          },
          executionId,
          subtaskKey: node.id,
          level: evaluation.decision === "BLOCKED" ? "warn" : "info",
        });
        await deps.api
          .upsertTaskContext?.({
            taskId,
            projectId: project._id,
            originalRequest: input.sharedContext.originalRequest,
            objective: input.sharedContext.objective,
            status: (task.status as any) || "running",
            decisions: input.sharedContext.decisions,
            artifacts: input.sharedContext.artifacts,
            outstandingIssues: input.sharedContext.outstandingIssues,
            // Phase 5: keep the persisted budget snapshot current
            // after every evaluation, so recovery restores the
            // tracker as of the last finished subtask.
            budgetSnapshot: input.budget.snapshot(),
          })
          ?.catch(() => undefined);
      }
    } catch (err) {
      await deps.api
        .logEvent({
          taskId,
          projectId: project._id,
          type: "orchestrator.evaluation_failed",
          payload: {
            subtaskKey: node.id,
            message: err instanceof Error ? err.message : String(err),
          },
          executionId,
          subtaskKey: node.id,
          level: "warn",
        })
        .catch(() => undefined);
    }
  }
  if (outcome.status === "completed") {
    state.priorOutputs.set(node.id, outcome.output ?? "");
    return dynamicNodes;
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
  return dynamicNodes;
}
