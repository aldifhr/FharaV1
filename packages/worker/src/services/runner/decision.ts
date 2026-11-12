import { observationFromOutcome } from "@/api/convex/lib/observations";
import type { RunContext, RunState } from "./types";
import type { SchedulerNode, NodeOutcome } from "@/scheduler/dagScheduler";
import type { ReviewResult } from "@/utils/json";
import { evaluateAfterExecution } from "@/orchestrator/orchestrator";
import type { DecisionContext, DecisionObservation } from "@/orchestrator/decision";
import { decideNext, directNext, judgeObjective, targetAgent } from "@/orchestrator/decisionEngine";
import { decideWithLlm } from "@/orchestrator/decisionLlm";
import { toAgentResult } from "./setup";
import { resolveIssuesForApproval, resolveIssuesForQaPass } from "@/orchestrator/taskContext";
import type { Escalation } from "@/api/convex/lib/subtaskContract";
import { handleEscalation } from "./escalation";
import { handleArchDecision } from "./archDecision";
import { agentRoleLabel, postSystemLine } from "./systemLines";
import { captureRunCheckpoint } from "./checkpoints";

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
  // GOAT G5: a hidden-ref checkpoint of the worktree after each finished
  // subtask (best effort; a node settled by an earlier run was captured then).
  if (outcome.status === "completed" && !settledEarlier) await captureRunCheckpoint(ctx, "subtask", node.id);
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
  // O1: the CTO's architecture verdict. revise/stop end this invocation
  // (executePlan reads ctx.archDecision); go lets the gated work run.
  if (outcome.status === "completed" && !settledEarlier) {
    const verdict = await handleArchDecision(ctx, node.id, outcome.output, executionId);
    if (verdict === "revise" || verdict === "stop") return undefined;
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
          planSubtasks: plan.subtasks,
          writerByKey: agentByKey,
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
        // observation (decisionEngine.judgeObjective owns when it is
        // judgeable: empty code change → unmet; skipped node, stage-loop
        // fix or review/QA in flight → deferred as met; else evaluated).
        const judgment = judgeObjective({
          context: decisionContext,
          nodeKey: node.id,
          executed: Boolean(executionId),
          inStageLoop: ctx.inStageLoop,
          completed: outcome.status === "completed",
          dynamicKeys,
          appliedFilesBySubtask: state.appliedFilesBySubtask,
          qaVerdicts: state.qaVerdicts,
          verification: state.verification,
        });
        if (judgment.unmet) {
          const logged = deps.api.logEvent({
            taskId: task._id,
            projectId: project._id,
            type: "orchestrator.objective_unmet",
            payload: judgment.unmet,
            executionId,
            subtaskKey: node.id,
            level: "warn",
          });
          // An unmet evaluated objective propagates a logging failure
          // (orchestrator.evaluation_failed), as before; the empty
          // code-change event is best effort.
          await (judgment.source === "empty_code_change" ? logged.catch(() => undefined) : logged);
        }
        observation.objective = judgment.state;
        const { decision: decided, fallback, stepLimit } = await decideNext(
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
        // task explicitly, never silently mark it done. Latch the halt
        // so the scheduler drains instead of starting more.
        if (stepLimit) {
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
        // Decision narration stays in events only: the chat gets ONE
        // report from the Response Owner at completion (O2). A "Please handle X" /
        // "Please revise" chat line per decision was the remaining
        // spam source (the delegation/revise itself, via applyDecision,
        // is unaffected).
        // P1b phase 1: the engine applies the decision and every runner
        // veto (decisionEngine/overrides.ts) and returns one directive;
        // this switch only performs it.
        const directive = directNext(
          decisionContext,
          decision,
          {
            plan,
            nodeKey: node.id,
            nodeKind: subtaskDef.kind,
            completedKeys: runCompleted,
            dynamicKeys,
            executed: Boolean(executionId),
            inStageLoop: ctx.inStageLoop,
            plannedQaCount: ctx.qaNodes.length,
            qaMode: deps.policy.qaMode,
            budgetEnforced,
            budgetHalted: ctx.budgetHalt,
            waitingForInput: ctx.waitingForInput !== null,
          },
          ctx.replanFeedback,
          (base) => uniqueSubtaskKey(`${base}_${ctx.decisionStep}`)
        );
        // Plan 013 step 3: the applied outcome is real (vetoes applied). `nodes`
        // spawns dynamic subtasks; `halt` is a budget BLOCKED and
        // stops scheduling on the budget-exhausted path; `complete`
        // latches the terminal flag ONLY when no planned node
        // remains pending (otherwise completion is deferred and
        // recorded — the remaining stages own the objective);
        // `replan` latches too and `ctx.replanFeedback` carries the
        // objective missing list back to processTask's bounded
        // re-plan; `ask_user` is a recorded no-op until step 4.
        switch (directive.kind) {
          case "spawn": {
            if (directive.qa) {
              const qa = directive.qa;
              await deps.api
                .logEvent({
                  taskId: task._id,
                  projectId: project._id,
                  type: qa.keep ? "qa.deferred" : "qa.suppressed",
                  payload: { keys: qa.keys, reason: qa.reason },
                })
                .catch(() => undefined);
              if (qa.keep) {
                for (const node of qa.deferred) {
                  plan.subtasks.push(node);
                  dynamicKeys.add(node.key);
                  chainByKey.set(node.key, [...chain, node.capability]);
                  fixDepthByKey.set(node.key, 0);
                  ctx.qaNodes.push(node);
                }
                await persistDynamic(qa.deferred, "delegation");
              }
            }
            const spawnNodes = directive.nodes;
            if (spawnNodes.length > 0) {
              for (const dynamic of spawnNodes) {
                plan.subtasks.push(dynamic);
                dynamicKeys.add(dynamic.key);
                chainByKey.set(dynamic.key, [...chain, dynamic.capability]);
                fixDepthByKey.set(dynamic.key, 0);
              }
              await persistDynamic(spawnNodes, directive.origin);
              dynamicNodes = spawnNodes.map((dynamic) => ({
                id: dynamic.key,
                dependencies: dynamic.dependencies,
                paths: dynamic.allowedPaths,
                writes: dynamic.kind === "code_change" || dynamic.kind === "shell",
              }));
            }
            break;
          }
          case "halt_budget": {
            ctx.budgetHalt = true;
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "orchestrator.budget_blocked",
              payload: {
                subtaskKey: node.id,
                reason: directive.reason.slice(0, 500),
                budget: input.budget.snapshot(),
              },
              executionId,
              subtaskKey: node.id,
              level: "warn",
            });
            break;
          }
          case "complete": {
            ctx.decisionTerminal = true;
            await deps.api.logEvent({
              taskId: task._id,
              projectId: project._id,
              type: "orchestrator.completed",
              payload: { expectedOutcome: directive.expectedOutcome },
              executionId,
              subtaskKey: node.id,
              level: "info",
            });
            break;
          }
          case "replan": {
            ctx.decisionTerminal = true;
            ctx.replanFeedback = directive.feedback;
            break;
          }
          case "ask_user": {
            // Plan 013 step 4: pause in `waiting_input` with the question
            // visible; a refused pause (lease lost / task already
            // terminal) is recorded and the run continues.
            const paused = await deps.api
              .pauseForInput({
                taskId,
                question: directive.question,
                options: directive.options,
                workerId: deps.workerId,
              })
              .catch(() => null);
            if (paused?.applied) {
              ctx.waitingForInput = directive.question;
              ctx.decisionTerminal = true;
            }
            break;
          }
          case "call_agent": {
            // Ephemeral invocation: no subtask row, no DAG change; the
            // answer already exists in the agent output. O2: a neutral
            // System line (the reasoning stays in the decision events).
            input.budget.incrementDelegation();
            const invoked = targetAgent(decision, input.agents, deps.policy.allowFallback);
            await postSystemLine(deps, { taskId, projectId: project._id, content: `Consulted ${invoked ? agentRoleLabel(invoked) : directive.capability}` });
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
          const nextAgent = targetAgent(decision, input.agents, deps.policy.allowFallback);
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
