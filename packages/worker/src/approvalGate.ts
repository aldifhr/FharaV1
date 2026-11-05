export type ApprovalKind = "apply_changes" | "git_push" | "run_command";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalDecision {
  status: ApprovalStatus;
}

/**
 * ponytail: polling sederhana; cukup untuk 1 worker.
 * Upgrade: Convex reactive subscription / webhook saat >1 worker.
 */
export async function waitForApproval(
  getDecision: () => Promise<ApprovalDecision>,
  opts: { pollMs?: number; timeoutMs?: number; onPoll?: (status: ApprovalStatus) => void } = {}
): Promise<ApprovalDecision> {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const decision = await getDecision();
    opts.onPoll?.(decision.status);
    if (decision.status !== "pending") return decision;
    if (Date.now() > deadline) {
      throw new Error("Approval timed out");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
