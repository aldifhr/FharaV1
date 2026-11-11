/**
 * GOAT G12b: how permission modes (plans/020) govern the Fhara MCP write
 * tools. Pure; the backend (mcpWrite.ts) applies it, tests pin it.
 *
 * An MCP caller holds the worker's MCP bearer token, not the user's
 * approval, so it can never approve anything and never raise a mode:
 *
 * - task.create starts a task only when the caller asked for it
 *   (`approved`), the project's mode is full access, and the request did
 *   not come from a chat. Otherwise it saves a draft the user starts.
 *   Chat never auto-starts a task, whatever the mode.
 * - The new task's mode can be the project's or stricter, never looser.
 * - thread.send, question.ask and run.report_result change no files and
 *   approve nothing, so every mode allows them; a settled task refuses
 *   question.ask and run.report_result (terminal tasks are immutable).
 */
import type { PermissionMode } from "./permissionModes";

const RANK: Record<PermissionMode, number> = { supervised: 0, auto_edits: 1, full_access: 2 };

/** True when `requested` would let the task do more than `ceiling` allows. */
export function isLooserMode(requested: PermissionMode, ceiling: PermissionMode): boolean {
  return RANK[requested] > RANK[ceiling];
}

export type McpTaskStartDecision =
  | { kind: "start"; mode: PermissionMode; reason: string }
  | { kind: "draft"; mode: PermissionMode; reason: string }
  | { kind: "refused"; reason: "permission_mode_escalation"; message: string };

export function mcpTaskStartDecision(input: {
  projectMode: PermissionMode;
  requestedMode?: PermissionMode;
  approved: boolean;
  fromChat: boolean;
}): McpTaskStartDecision {
  const mode = input.requestedMode ?? input.projectMode;
  if (isLooserMode(mode, input.projectMode)) {
    return {
      kind: "refused",
      reason: "permission_mode_escalation",
      message: `Requested ${mode} is looser than the project's ${input.projectMode}`,
    };
  }
  if (input.fromChat) return { kind: "draft", mode, reason: "Chat never starts a task; the user starts the draft" };
  if (!input.approved) return { kind: "draft", mode, reason: "Not approved; the user starts the draft" };
  if (input.projectMode !== "full_access") {
    return { kind: "draft", mode, reason: `The project is ${input.projectMode}; only full access lets MCP start a task` };
  }
  return { kind: "start", mode, reason: "Approved under full access" };
}
