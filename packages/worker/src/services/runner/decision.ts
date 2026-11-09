import { observationFromOutcome } from "@/api/convex/lib/observations";
import type { RunContext, RunState } from "./types";
import type { SchedulerNode, NodeOutcome } from "@/scheduler/dagScheduler";
import type { PlanSubtask } from "@/types";
import type { ReviewResult } from "@/utils/json";
import { evaluateAfterExecution } from "@/orchestrator/orchestrator";
import { decide, applyDecision, evaluateObjective, type DecisionContext, type DecisionObservation } from "@/orchestrator/decision";
import { decideWithLlm } from "@/orchestrator/decisionLlm";
import { toAgentResult } from "./setup";
import { normalizeCapability, routeCapability } from "@/orchestrator/capabilities";
import { CAPABILITY } from "@/types";
import { resolveIssuesForApproval, resolveIssuesForQaPass } from "@/orchestrator/taskContext";
import type { Escalation } from "@/api/convex/lib/subtaskContract";
import { handleEscalation } from "./escalation";

export async function handleNodeOutcome(
  ctx: RunContext,
  node: SchedulerNode,
  outcome: NodeOutcome,
  attempt: number,
): Promise<SchedulerNode[] | undefined> {
  const {
    agentByKey, executionIds, runCompleted, activeByAgent, chainByKey,
    fixDepthByKey, dynamicKeys, plannedCapabilities, budgetEnforced,
    plan, state, deps, task, project,
    input, taskId,
    uniqueSubtaskKey, persistDynamic,
  } = ctx;
{
  const agent = agentByKey.get(node.id);
  const executionId = executionIds.get(node.id);
  // A node that was already complete when it settled (skipped as
  // "Previously completed" on an approval resume / recovery) was decided by
  // the run that executed it: re-judging it re-emitted one
  // orchestrator.decision per finished subtask on every resume.
  const settledEarlier = outcome.status === "completed" && runCompleted.has(node.id);
  // The node has settled: it no longer counts as active work for
  // its agent (a scheduler retry re-enters via onStart).
  if (agent && !runCompleted.has(node.id)) {
    activeByAgent.set(
      agent._id,
      Math.max(0, (activeByAgent.get(agent._id) ?? 1) - 1)
    );
  }
  let dynamicNodes: SchedulerNode[] | undefined;
  // Plan 022: an escalated executor stopped for a decision. Its meta is
  // kept on the execution row (the decision engine never judges it).
  const escalation =
    outcome.status === "failed"
      ? ((outcome.meta as { escalation?: Escalation } | undefined)?.escalation ?? null)
      : null;
  if (!runCompleted.has(node.id) && executionId) {
    const written = (await deps.api.updateExecution({
      executionId,
      subtaskKey: node.id,
      status: outcome.status === "completed" ? "completed" : "failed",
      output: outcome.status === "failed" ? undefined : outcome.output,
      error: outcome.status === "failed" ? outcome.error : undefined,
      meta: outcome.status === "failed" ? (escalation ? { escalation } : undefined) : outcome.meta,
    })) as { applied?: boolean; reason?: string } | null | undefined;
    // Lease fencing: another worker owns this task now. Stop this run
    // cleanly (abort) instead of writing over the new owner's state.
    if (written && written.applied === false && written.reason === "lease_lost") {
      input.taskAbort?.abort(new Error("Lease lost: another worker owns this task"));
    }
  }
  if (escalation && outcome.status === "failed") {
    state.feedback.push(`${node.id}: ${outcome.error}`);
    await handleEscalation(ctx, node.id, escalation, executionId);
    if (agent) {
      await deps.api
        .appendAgentMessage({
          projectId: project._id,
          taskId,
          agentId: agent._id,
          content: `Subtask ${node.id} stopped for a decision: ${escalation.reason}`,
          subtaskKey: node.id,
          executionId,
        })
        .catch(() => undefined);
    }
    return undefined;
  }
  // A node that settles completed joins this run's completion set
  // BEFORE the decision engine reads it below, so a finished node is
  // never treated as pending work.
  if (outcome.status === "completed") {
    runCompleted.add(node.id);
    if (!settledEarlier) (state.deliveredOutputs ??= new Map()).set(node.id, outcome.output ?? "");
  }
  const subtaskKind = plan.subtasks.find((candidate) => candidate.key === node.id)?.kind;
  const meta = outcome.meta as
    | { verdict?: string; findings?: ReviewResult["findings"]; snapshotId?: string }
    | undefined;
  if (
    subtaskKind === "review" &&
    outcome.status === "completed" &&
    (meta?.verdict === "approved" || meta?.verdict === "changes_requested")
  ) {
    state.reviewVerdicts[node.id] = {
      verdict: meta.verdict,
      findings: Array.isArray(meta.findings) ? meta.findings : [],
      ...(typeof meta.snapshotId === "string" ? { snapshotId: meta.snapshotId } : {}),
    };
  }
  if (
    subtaskKind === "qa" &&
    (meta?.verdict === "passed" ||
      meta?.verdict === "failed" ||
      meta?.verdict === "inconclusive" ||
      meta?.verdict === "blocked")
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
      // Scope: a QA pass resolves only issues QA raised (P0-2).
      input.sharedContext.outstandingIssues = resolveIssuesForQaPass(
        input.sharedContext.outstandingIssues,
        approvedFiles,
        { qaAgentNames: new Set(agent?.name ? [agent.name] : []) }
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
  if (input.budget && input.sharedContext && input.classification && agent && !settledEarlier) {
    try {
      const subtaskDef = plan.subtasks.find((candidate) => candidate.key === node.id);
      if (subtaskDef) {
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
          // Plan 025: the same typed observation the backend derives from
          // this execution settling, with the files it staged.
          observations: [
            observationFromOutcome({
              subtaskKey: node.id,
              agentId: agent._id,
              status: outcome.status === "completed" ? "completed" : "failed",
              error: outcome.status === "failed" ? outcome.error : undefined,
              affectedFiles: state.appliedFilesBySubtask.get(node.id),
              executionId: executionId ?? undefined,
            }),
          ],
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
        // Plan 013 step 5: the objective state travels with the
        // observation. decide() consults the advisor where the
        // objective is unmet and, without one, applies the recovery
        // rule (missing work → replan, no path → ask_user); the
        // retired post-hoc downgrade used to reclassify here.
        //
        // Only a node that EXECUTED in this run may be judged.
        // A node skipped as "Previously completed" on resume /
        // recovery has no executionId this run; evaluating its
        // objective here compares against rebuilt in-memory
        // evidence, which is incomplete for that node, so any
        // verdict would be fabricated. The previous run already
        // decided these nodes. While a review or QA loop is in
        // flight its open findings are EXPECTED (the loop owns
        // them), so the objective is not judgeable either. All
        // three non-judgeable cases defer as met with evidence.
        const reviewQaInFlight = plan.subtasks.some(
          (candidate) =>
            (candidate.kind === "review" || candidate.kind === "qa") &&
            !dynamicKeys.has(candidate.key) &&
            !runCompleted.has(candidate.key)
        );
        let objectiveState: DecisionObservation["objective"];
        if (!executionId || ctx.inStageLoop || reviewQaInFlight) {
          objectiveState = {
            met: true,
            missing: [],
            evidence: ["objective evaluation deferred (skipped node, review/QA loop in flight, or loop fix)"],
          };
        } else {
          const objective = evaluateObjective({
            ...decisionContext,
            dynamicKeys,
            objectiveEvidence: {
              appliedFiles: Object.fromEntries(state.appliedFilesBySubtask),
              qaVerdicts: state.qaVerdicts,
              verification: state.verification,
            },
          });
          objectiveState = {
            met: objective.satisfied,
            missing: objective.missing,
            evidence: objective.evidence,
          };
          if (!objective.satisfied) {
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
          }
        }
        observation.objective = objectiveState;
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
                plannerAgent: input.plannerAgent,
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
        let decision = decided;
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
        // Plan 013 step 3: the applied outcome is real. `nodes`
        // spawns dynamic subtasks; `halt` is a budget BLOCKED and
        // stops scheduling on the budget-exhausted path; `complete`
        // latches the terminal flag ONLY when no planned node
        // remains pending (otherwise completion is deferred and
        // recorded — the remaining stages own the objective);
        // `replan` latches too and `ctx.replanFeedback` carries the
        // objective missing list back to processTask's bounded
        // re-plan; `ask_user` is a recorded no-op until step 4.
        switch (applied.kind) {
          case "nodes": {
            // Review-kind nodes are owned by the review loop: a
            // REVISE (execute) here never spawns a fix subtask —
            // the loop already builds its own per-iteration fixes,
            // and a second fix loop would double the work. (The
            // retired legacy branch enforced the same exclusion.)
            if (subtaskDef.kind === "review" && decision.action === "execute") break;
            // Dynamic QA (browser-testing delegation) is stage-managed
            // (QA audit P0-3): suppressed entirely under qaMode=never, and
            // otherwise DEFERRED to the post-apply QA stage instead of
            // running now against the unapplied workspace. When the plan
            // already has QA nodes they cover it, so it is dropped.
            const isQaNode = (n: PlanSubtask) =>
              n.kind === "qa" || normalizeCapability(n.capability) === CAPABILITY.BROWSER_TESTING;
            const qaSpawned = applied.nodes.filter(isQaNode);
            const spawnNodes = applied.nodes.filter((n) => !isQaNode(n));
            if (qaSpawned.length > 0) {
              const keepQa = deps.policy.qaMode !== "never" && ctx.qaNodes.length === 0;
              await deps.api
                .logEvent({
                  taskId: task._id,
                  projectId: project._id,
                  type: keepQa ? "qa.deferred" : "qa.suppressed",
                  payload: {
                    keys: qaSpawned.map((n) => n.key),
                    reason: keepQa
                      ? "dynamic QA runs in the post-apply QA stage"
                      : deps.policy.qaMode === "never"
                        ? "qaMode=never"
                        : "plan already has QA nodes",
                  },
                })
                .catch(() => undefined);
              if (keepQa) {
                const deferred = qaSpawned.map((n) => ({ ...n, kind: "qa" as const }));
                for (const node of deferred) {
                  plan.subtasks.push(node);
                  dynamicKeys.add(node.key);
                  chainByKey.set(node.key, [...chain, node.capability]);
                  fixDepthByKey.set(node.key, 0);
                  ctx.qaNodes.push(node);
                }
                await persistDynamic(deferred, "delegation");
              }
            }
            if (spawnNodes.length > 0) {
              for (const dynamic of spawnNodes) {
                plan.subtasks.push(dynamic);
                dynamicKeys.add(dynamic.key);
                chainByKey.set(dynamic.key, [...chain, dynamic.capability]);
                fixDepthByKey.set(dynamic.key, 0);
              }
              await persistDynamic(spawnNodes, decision.action === "execute" ? "fix" : "delegation");
              dynamicNodes = spawnNodes.map((dynamic) => ({
                id: dynamic.key,
                dependencies: dynamic.dependencies,
                paths: dynamic.allowedPaths,
              }));
            }
            break;
          }
          case "halt": {
            // Warn mode: the BLOCKED evaluation is advisory only
            // (same rule as the legacy evaluation branch — the
            // budget.warning event from the pre-call gate is the
            // visible signal and the run continues). Only enforce
            // mode latches the halt.
            if (budgetEnforced && !ctx.budgetHalt) {
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
          case "complete": {
            const noPlannedPending = plan.subtasks.every(
              (candidate) => candidate.key === node.id || runCompleted.has(candidate.key)
            );
            // The latch only honors the objective judged for work THIS
            // run executed: a resumed/skipped node settled on store
            // state only, and halting would block its resumable dynamic
            // siblings (Phase 4 recovery, plan 011 step 4).
            if (applied.expectedOutcome === "objective:met" && executionId && noPlannedPending && !ctx.inStageLoop) {
              ctx.decisionTerminal = true;
              await deps.api.logEvent({
                taskId: task._id,
                projectId: project._id,
                type: "orchestrator.completed",
                payload: { expectedOutcome: applied.expectedOutcome },
                executionId,
                subtaskKey: node.id,
                level: "info",
              });
            }
            break;
          }
          case "replan": {
            // Objective-recovery replans defer while spawned recovery
            // work is still pending: re-planning mid-recovery would
            // discard the very fix meant to close the objective gap
            // (plan 013 step 7). The recovery's later decisions re-run
            // the recovery rule once nothing dynamic is outstanding.
            const recoveryPending = plan.subtasks.some(
              (candidate) => dynamicKeys.has(candidate.key) && !runCompleted.has(candidate.key)
            );
            if (recoveryPending) break;
            // A staged loop (review / verification / QA) owns recovery
            // of its own nodes: a failing QA verdict or verify fix is
            // handled by the loop's bounded fix rounds, which fail the
            // task on exhaustion. Latching a replan here would halt the
            // loop's own fix node before it can run.
            if (ctx.inStageLoop) break;
            ctx.decisionTerminal = true;
            // First request wins: the earliest missing list is the
            // feedback the bounded re-plan will address.
            if (ctx.replanFeedback === null) {
              ctx.replanFeedback = applied.reason;
            }
            break;
          }
          case "ask_user": {
            // Plan 013 step 4: pause the task in `waiting_input`
            // with the question visible. The first applied pause
            // wins; a refused pause (lease lost / task already
            // terminal) is recorded and the run continues.
            if (ctx.waitingForInput === null) {
              const paused = await deps.api
                .pauseForInput({
                  taskId,
                  question: applied.question,
                  options: applied.options,
                  workerId: deps.workerId,
                })
                .catch(() => null);
              if (paused?.applied) {
                ctx.waitingForInput = applied.question;
                ctx.decisionTerminal = true;
              }
            }
            break;
          }
          case "call_agent": {
            // Ephemeral invocation: the runner's LLM call path invoked the
            // routed agent directly — no subtask row, no DAG change, no
            // persistence. The answer already exists in the agent output; we
            // just log the call for the trace.
            input.budget.incrementDelegation();
            const invoked = decision.target?.capability
              ? routeCapability(decision.target.capability, input.agents, {
                  allowFallback: deps.policy.allowFallback,
                })
              : undefined;
            await deps.api
              .appendAgentMessage({
                projectId: project._id,
                taskId: task._id as any,
                agentId: invoked?._id as any,
                content: `[call_agent: ${invoked?.name ?? applied.capability}] ${applied.reasoning.slice(0, 300)}`,
                subtaskKey: node.id,
                executionId,
              })
              .catch(() => undefined);
            break;
          }
        }
        // Engine parity (plan 013 step 7): a delegation counts,
        // records, and hands off in engine mode too — just like
        // the retired legacy branch did. Counting is unconditional
        // budget bookkeeping (independent of budgetMode); the
        // count/depth gates themselves stay mode-dependent in
        // validateDecision.
        if (decision.action === "delegate") {
          input.budget.incrementDelegation();
          const nextAgent = decision.target?.agentId
            ? input.agents.find((candidate) => candidate._id === decision.target!.agentId) as
              | (typeof input.agents)[number]
              | undefined
            : decision.target?.capability
              ? routeCapability(decision.target.capability, input.agents, {
                  allowFallback: deps.policy.allowFallback,
                })
              : undefined;
          await deps.api
            .recordDelegation?.({
              taskId,
              projectId: project._id,
              fromAgentId: agent._id,
              toAgentId: nextAgent?._id,
              decision: "APPROVE",
              reason: decision.reasoning,
              capability: decision.target?.capability ?? nextAgent?.capabilities?.[0],
            })
            ?.catch(() => undefined);
          // Plan 006 Phase 4: delegation proposals write the
          // addressed message row so the target agent sees the
          // handoff, visible in the shared chat as an @-mention.
          if (nextAgent) {
            await deps.api
              .appendAgentMessage({
                projectId: project._id,
                taskId: task._id as any,
                agentId: agent._id as any,
                content: `@${nextAgent.name} ${decision.reasoning.slice(0, 300)}`,
                subtaskKey: dynamicNodes?.[0]?.id ?? node.id,
                executionId,
              })
              .catch(() => undefined);
          }
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
}
