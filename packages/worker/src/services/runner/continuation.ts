/**
 * G4 restart continuation, the run side: a subtask a dead worker cut off
 * (state.ts `planContinuations`) runs as a continuation of itself. Its
 * prompt carries CONTINUE_PROMPT plus the steps it already recorded, and
 * a recorded command that may have changed state is never run again (the
 * command gate answers it with via "recorded"). A continuation the loop
 * guard refused fails the node with the guard's reason, so the task fails
 * or holds the normal way.
 */
import type { CommandApprovalOutcome } from "@/execution/commandGate";
import { SUBTASK_CONTINUED_EVENT } from "@/api/convex/lib/restartContinuation";
import type { RunnerDeps, RunState } from "./types";

type CommandRequest = { command: string; args: string[] };
type LogInput = Parameters<RunnerDeps["api"]["logEvent"]>[0];

export interface PreparedNode<S extends { description: string }> {
  /** Set when the loop guard refused the continuation: fail the node with it. */
  refused?: string;
  subtask: S;
  /** Wraps the node's command approval: recorded side effects are not run again. */
  gate: (cmd: CommandRequest, ask: () => Promise<CommandApprovalOutcome>) => Promise<CommandApprovalOutcome>;
}

const passthrough: PreparedNode<{ description: string }>["gate"] = (_cmd, ask) => ask();

/**
 * Prepare one node: a plain node passes through; a cut-off node gets the
 * continuation brief appended to its description and the recorded-effect
 * gate, and its start is recorded as `subtask.continued` (the guard counts
 * these). Used once per node per run.
 */
export async function prepareContinuation<S extends { description: string }>(
  deps: Pick<RunnerDeps, "api">,
  input: { taskId: LogInput["taskId"]; projectId: LogInput["projectId"]; executionId?: LogInput["executionId"]; nodeId: string; state: Pick<RunState, "continuations">; subtask: S }
): Promise<PreparedNode<S>> {
  const continuation = input.state.continuations?.get(input.nodeId);
  if (!continuation) return { subtask: input.subtask, gate: passthrough };
  const where = { taskId: input.taskId, projectId: input.projectId, subtaskKey: input.nodeId, ...(input.executionId ? { executionId: input.executionId } : {}) };
  if (!continuation.allowed) {
    await deps.api
      .logEvent({ ...where, type: "subtask.continuation_refused", payload: { reason: continuation.reason }, level: "warn" })
      .catch(() => undefined);
    return { refused: continuation.reason, subtask: input.subtask, gate: passthrough };
  }
  input.state.continuations?.delete(input.nodeId);
  await deps.api.logEvent({
    ...where,
    type: SUBTASK_CONTINUED_EVENT,
    payload: { attempt: continuation.attempt, steps: continuation.steps.length, sideEffects: continuation.sideEffects },
    level: "warn",
  });
  const effects = new Set(continuation.sideEffects);
  return {
    subtask: { ...input.subtask, description: `${input.subtask.description}\n\n${continuation.text}` },
    gate: async (cmd, ask) => {
      const line = [cmd.command, ...cmd.args].join(" ").trim();
      if (!effects.has(line)) return await ask();
      await deps.api
        .logEvent({ ...where, type: "shell.command_declined", payload: { command: cmd.command, args: cmd.args, via: "recorded" }, level: "warn" })
        .catch(() => undefined);
      return { allowed: false, via: "recorded", reason: "It already ran before the worker was cut off, so it is not run again" };
    },
  };
}
