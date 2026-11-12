import { useEffect, useRef } from "react";

type BoundApproval = { _id: string; fingerprint?: string };

/**
 * O6: decisions carry the fingerprint of the approval this chat showed and
 * when it first showed it; the backend refuses a changed or stale one.
 * Returns the args to spread into an approve / reject / respond call.
 */
export function useApprovalBinding(approvals: readonly BoundApproval[] | undefined) {
  const shownAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    for (const row of approvals ?? []) {
      const key = `${row._id}:${row.fingerprint}`;
      if (!shownAtRef.current.has(key)) shownAtRef.current.set(key, Date.now());
    }
  }, [approvals]);
  return (approvalId: unknown): { fingerprint?: string; shownAt?: number } => {
    const row = approvals?.find((a) => a._id === approvalId);
    if (!row?.fingerprint) return {};
    const key = `${row._id}:${row.fingerprint}`;
    if (!shownAtRef.current.has(key)) shownAtRef.current.set(key, Date.now());
    return { fingerprint: row.fingerprint, shownAt: shownAtRef.current.get(key)! };
  };
}
