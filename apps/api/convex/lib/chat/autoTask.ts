/**
 * Plan 061: the one decision "does this chat message create its task now?".
 * Pure on purpose — no Convex, no LLM, no env — so the rollout can be pinned by
 * a small table of cases. A false answer always leaves today's offer flow in
 * place. Nothing here approves or applies anything.
 */
export interface AutoTaskInput {
  /** Deterministic work shape (change request or polite write request). */
  workShaped: boolean;
  /** "tolong jalankan tes" / "run npm test". */
  runRequest: boolean;
  optionPick: boolean;
  pasted: boolean;
  mentionCount: number;
  /** Project field; absent means enabled. */
  autoCreateChatTasks: boolean | undefined;
}

export function shouldAutoCreateTask(input: AutoTaskInput): boolean {
  if (input.autoCreateChatTasks === false) return false;
  if (input.optionPick || input.pasted || input.mentionCount > 0) return false;
  return input.workShaped || input.runRequest;
}
